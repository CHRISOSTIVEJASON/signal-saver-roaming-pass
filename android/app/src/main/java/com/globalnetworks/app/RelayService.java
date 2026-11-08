package com.globalnetworks.app;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.*;
import java.io.*;
import java.net.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

public class RelayService extends Service {
    public static final int RELAY_PORT = 8282;
    public static final String ACTION_START_HOST = "com.globalnetworks.app.START_HOST";
    public static final String ACTION_STOP = "com.globalnetworks.app.STOP";

    private static final AtomicBoolean routerRunning = new AtomicBoolean(false);
    private static final AtomicLong totalSentBytes = new AtomicLong(0);
    private static final AtomicLong totalReceivedBytes = new AtomicLong(0);

    private ServerSocket serverSocket;
    private ExecutorService threadPool;

    public static boolean isRouterRunning() {
        return routerRunning.get();
    }

    public static long getSentBytes() {
        return totalSentBytes.get();
    }

    public static long getReceivedBytes() {
        return totalReceivedBytes.get();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP.equals(action)) {
            stopRouter();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundNotification("Global Networks Relay", "Packet router bridge is active on port " + RELAY_PORT);
        startRouter();
        return START_STICKY;
    }

    private void startForegroundNotification(String title, String text) {
        String channelId = "global-network-relay";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel nc = new NotificationChannel(channelId, "Global Networks connection", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(nc);
            }
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channelId) : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true);
        startForeground(1, builder.build());
    }

    private synchronized void startRouter() {
        if (routerRunning.get()) return;
        routerRunning.set(true);
        threadPool = Executors.newCachedThreadPool();

        threadPool.execute(() -> {
            try {
                serverSocket = new ServerSocket();
                serverSocket.setReuseAddress(true);
                serverSocket.bind(new InetSocketAddress("0.0.0.0", RELAY_PORT));

                while (routerRunning.get() && !serverSocket.isClosed()) {
                    try {
                        Socket clientSocket = serverSocket.accept();
                        clientSocket.setTcpNoDelay(true);
                        clientSocket.setKeepAlive(true);
                        threadPool.execute(() -> handleConnection(clientSocket));
                    } catch (Exception e) {
                        if (!routerRunning.get()) break;
                    }
                }
            } catch (Exception e) {
                routerRunning.set(false);
            }
        });
    }

    private void handleConnection(Socket client) {
        try {
            BufferedInputStream in = new BufferedInputStream(client.getInputStream());
            in.mark(1024);

            byte[] peek = new byte[16];
            int read = in.read(peek);
            if (read <= 0) {
                client.close();
                return;
            }
            in.reset();

            if (peek[0] == 0x05) {
                handleSocks5(client, in);
            } else {
                handleHttp(client, in);
            }
        } catch (Exception e) {
            try { client.close(); } catch (Exception ignored) {}
        }
    }

    private void handleHttp(Socket client, InputStream in) throws Exception {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in));
        String requestLine = reader.readLine();
        if (requestLine == null || requestLine.isEmpty()) {
            client.close();
            return;
        }

        String[] parts = requestLine.split(" ");
        if (parts.length < 2) {
            client.close();
            return;
        }

        String method = parts[0].toUpperCase();
        String target = parts[1];
        String host;
        int port;

        if ("CONNECT".equals(method)) {
            String[] hostPort = target.split(":");
            host = hostPort[0];
            port = hostPort.length > 1 ? Integer.parseInt(hostPort[1]) : 443;

            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {}

            Socket remote = createUpstreamSocket(host, port);
            OutputStream clientOut = client.getOutputStream();
            clientOut.write("HTTP/1.1 200 Connection Established

".getBytes());
            clientOut.flush();

            pipeSockets(client, remote);
        } else {
            URL url;
            if (target.startsWith("http://") || target.startsWith("https://")) {
                url = new URL(target);
            } else {
                url = new URL("http://" + target);
            }
            host = url.getHost();
            port = url.getPort() != -1 ? url.getPort() : 80;

            Socket remote = createUpstreamSocket(host, port);
            OutputStream remoteOut = remote.getOutputStream();

            String rewrittenPath = url.getFile();
            if (rewrittenPath == null || rewrittenPath.isEmpty()) rewrittenPath = "/";
            String newRequestLine = method + " " + rewrittenPath + " " + (parts.length > 2 ? parts[2] : "HTTP/1.1") + "
";
            remoteOut.write(newRequestLine.getBytes());

            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (!line.toLowerCase().startsWith("proxy-connection:")) {
                    remoteOut.write((line + "
").getBytes());
                }
            }
            remoteOut.write("
".getBytes());
            remoteOut.flush();

            pipeSockets(client, remote);
        }
    }

    private void handleSocks5(Socket client, InputStream in) throws Exception {
        DataInputStream dis = new DataInputStream(in);
        OutputStream out = client.getOutputStream();

        int nmethods = dis.readByte() & 0xFF;
        byte[] methods = new byte[nmethods];
        dis.readFully(methods);

        out.write(new byte[]{0x05, 0x00});
        out.flush();

        int ver = dis.readByte() & 0xFF;
        int cmd = dis.readByte() & 0xFF;
        int rsv = dis.readByte();
        int atyp = dis.readByte() & 0xFF;

        String host = null;
        if (atyp == 0x01) {
            byte[] ip = new byte[4];
            dis.readFully(ip);
            host = InetAddress.getByAddress(ip).getHostAddress();
        } else if (atyp == 0x03) {
            int len = dis.readByte() & 0xFF;
            byte[] domainBytes = new byte[len];
            dis.readFully(domainBytes);
            host = new String(domainBytes);
        } else {
            client.close();
            return;
        }
        int port = dis.readUnsignedShort();

        if (cmd != 0x01 || host == null) {
            out.write(new byte[]{0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0});
            out.flush();
            client.close();
            return;
        }

        Socket remote;
        try {
            remote = createUpstreamSocket(host, port);
        } catch (Exception e) {
            out.write(new byte[]{0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0});
            out.flush();
            client.close();
            return;
        }

        out.write(new byte[]{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0});
        out.flush();

        pipeSockets(client, remote);
    }

    private Socket createUpstreamSocket(String host, int port) throws IOException {
        Socket socket = new Socket();
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);

        if (Build.VERSION.SDK_INT >= 23) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                Network activeNetwork = cm.getActiveNetwork();
                if (activeNetwork != null) {
                    try {
                        activeNetwork.bindSocket(socket);
                    } catch (Exception ignored) {}
                }
            }
        }

        socket.connect(new InetSocketAddress(host, port), 10000);
        return socket;
    }

    private void pipeSockets(Socket a, Socket b) {
        CountDownLatch latch = new CountDownLatch(2);

        threadPool.execute(() -> {
            try {
                InputStream in = a.getInputStream();
                OutputStream out = b.getOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    out.flush();
                    totalReceivedBytes.addAndGet(n);
                }
            } catch (Exception ignored) {
            } finally {
                try { b.shutdownOutput(); } catch (Exception ignored) {}
                latch.countDown();
            }
        });

        threadPool.execute(() -> {
            try {
                InputStream in = b.getInputStream();
                OutputStream out = a.getOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    out.flush();
                    totalSentBytes.addAndGet(n);
                }
            } catch (Exception ignored) {
            } finally {
                try { a.shutdownOutput(); } catch (Exception ignored) {}
                latch.countDown();
            }
        });

        threadPool.execute(() -> {
            try {
                latch.await(2, TimeUnit.HOURS);
            } catch (Exception ignored) {
            } finally {
                try { a.close(); } catch (Exception ignored) {}
                try { b.close(); } catch (Exception ignored) {}
            }
        });
    }

    private synchronized void stopRouter() {
        routerRunning.set(false);
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (Exception ignored) {}
            serverSocket = null;
        }
        if (threadPool != null) {
            threadPool.shutdownNow();
            threadPool = null;
        }
    }

    @Override
    public void onDestroy() {
        stopRouter();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
