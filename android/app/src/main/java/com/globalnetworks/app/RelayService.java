package com.globalnetworks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.IBinder;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
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

            Socket upstreamSocket = createUpstreamSocket();
            upstreamSocket.connect(new InetSocketAddress(host, port), 10000);
            upstreamSocket.setTcpNoDelay(true);

            OutputStream clientOut = client.getOutputStream();
            clientOut.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes());
            clientOut.flush();

            bridgeSockets(client, upstreamSocket);
        } else {
            java.net.URL url;
            if (target.startsWith("http://") || target.startsWith("https://")) {
                url = new java.net.URL(target);
            } else {
                url = new java.net.URL("http://" + target);
            }
            host = url.getHost();
            port = url.getPort() != -1 ? url.getPort() : 80;

            Socket upstreamSocket = createUpstreamSocket();
            upstreamSocket.connect(new InetSocketAddress(host, port), 10000);
            upstreamSocket.setTcpNoDelay(true);

            OutputStream remoteOut = upstreamSocket.getOutputStream();
            String rewrittenPath = url.getFile();
            if (rewrittenPath == null || rewrittenPath.isEmpty()) rewrittenPath = "/";
            String newRequestLine = method + " " + rewrittenPath + " " + (parts.length > 2 ? parts[2] : "HTTP/1.1") + "\r\n";
            remoteOut.write(newRequestLine.getBytes());

            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                if (!line.toLowerCase().startsWith("proxy-connection:")) {
                    remoteOut.write((line + "\r\n").getBytes());
                }
            }
            remoteOut.write("\r\n".getBytes());
            remoteOut.flush();

            bridgeSockets(client, upstreamSocket);
        }
    }

    private void handleSocks5(Socket client, InputStream in) throws Exception {
        OutputStream out = client.getOutputStream();
        int version = in.read();
        if (version != 5) {
            client.close();
            return;
        }
        int nmethods = in.read();
        byte[] methods = new byte[nmethods];
        in.read(methods);

        out.write(new byte[]{0x05, 0x00});
        out.flush();

        byte[] header = new byte[4];
        in.read(header);
        int cmd = header[1];
        int atyp = header[3];

        String targetHost;
        if (atyp == 0x01) {
            byte[] ipv4 = new byte[4];
            in.read(ipv4);
            targetHost = java.net.InetAddress.getByAddress(ipv4).getHostAddress();
        } else if (atyp == 0x03) {
            int domainLen = in.read();
            byte[] domain = new byte[domainLen];
            in.read(domain);
            targetHost = new String(domain);
        } else if (atyp == 0x04) {
            byte[] ipv6 = new byte[16];
            in.read(ipv6);
            targetHost = java.net.InetAddress.getByAddress(ipv6).getHostAddress();
        } else {
            client.close();
            return;
        }

        byte[] portBytes = new byte[2];
        in.read(portBytes);
        int targetPort = ((portBytes[0] & 0xFF) << 8) | (portBytes[1] & 0xFF);

        if (cmd == 0x01) {
            try {
                Socket upstreamSocket = createUpstreamSocket();
                upstreamSocket.connect(new InetSocketAddress(targetHost, targetPort), 10000);
                upstreamSocket.setTcpNoDelay(true);

                byte[] resp = new byte[]{0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
                out.write(resp);
                out.flush();

                bridgeSockets(client, upstreamSocket);
            } catch (Exception e) {
                out.write(new byte[]{0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00});
                out.flush();
                client.close();
            }
        } else {
            out.write(new byte[]{0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00});
            out.flush();
            client.close();
        }
    }

    private Socket createUpstreamSocket() {
        Socket socket = new Socket();
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
                if (cm != null) {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        net.bindSocket(socket);
                    }
                }
            }
        } catch (Exception ignored) {}
        return socket;
    }

    private void bridgeSockets(Socket s1, Socket s2) {
        threadPool.execute(() -> pipe(s1, s2, totalSentBytes));
        threadPool.execute(() -> pipe(s2, s1, totalReceivedBytes));
    }

    private void pipe(Socket inSock, Socket outSock, AtomicLong counter) {
        try {
            InputStream in = inSock.getInputStream();
            OutputStream out = outSock.getOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                out.flush();
                counter.addAndGet(n);
            }
        } catch (Exception ignored) {
        } finally {
            try { inSock.close(); } catch (Exception ignored) {}
            try { outSock.close(); } catch (Exception ignored) {}
        }
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
