package com.globalnetworks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

public class RelayService extends Service {
    private static final String TAG = "RelayService";
    public static final int RELAY_PORT = 8282;
    public static final int DNS_RELAY_PORT = 8253;
    public static final String ACTION_START_HOST = "com.globalnetworks.app.START_HOST";
    public static final String ACTION_STOP = "com.globalnetworks.app.STOP";

    private static final AtomicBoolean routerRunning = new AtomicBoolean(false);
    private static final AtomicLong totalSentBytes = new AtomicLong(0);
    private static final AtomicLong totalReceivedBytes = new AtomicLong(0);

    private ServerSocket serverSocket;
    private DatagramSocket dnsRelaySocket;
    private ExecutorService threadPool;
    private PowerManager.WakeLock wakeLock;

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
            NetworkWatcher.getInstance(this).stop();
            stopRouter();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        startForegroundNotification("Global Networks Dual-Path Relay", "High-speed SOCKS5 TCP/UDP ASSOCIATE & DNS router active on port " + RELAY_PORT);
        startRouter();
        NetworkWatcher.getInstance(this).start();
        return START_STICKY;
    }

    private void startForegroundNotification(String title, String text) {
        try {
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
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(1, builder.build(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            } else {
                startForeground(1, builder.build());
            }
        } catch (Throwable t) {
            Log.w(TAG, "Foreground service notification could not be started", t);
        }
    }

    private synchronized void startRouter() {
        if (routerRunning.get()) return;
        routerRunning.set(true);
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null && (wakeLock == null || !wakeLock.isHeld())) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GlobalNetworks::RelayWakeLock");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(24 * 60 * 60 * 1000L);
            }
        } catch (Exception ignored) {}
        threadPool = Executors.newCachedThreadPool();

        // 1. TCP Proxy Server (HTTP / HTTPS / SOCKS5 TCP & UDP ASSOCIATE)
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
                        clientSocket.setReceiveBufferSize(65536);
                        clientSocket.setSendBufferSize(65536);
                        threadPool.execute(() -> handleConnection(clientSocket));
                    } catch (Exception e) {
                        if (!routerRunning.get()) break;
                    }
                }
            } catch (Exception e) {
                routerRunning.set(false);
        if (wakeLock != null) {
            try {
                if (wakeLock.isHeld()) wakeLock.release();
            } catch (Exception ignored) {}
            wakeLock = null;
        }
            }
        });

        // 2. High-speed DNS Forwarder on UDP DNS_RELAY_PORT
        threadPool.execute(() -> {
            try {
                dnsRelaySocket = new DatagramSocket(null);
                dnsRelaySocket.setReuseAddress(true);
                dnsRelaySocket.bind(new InetSocketAddress("0.0.0.0", DNS_RELAY_PORT));

                byte[] recvBuf = new byte[4096];
                while (routerRunning.get() && !dnsRelaySocket.isClosed()) {
                    try {
                        DatagramPacket inPacket = new DatagramPacket(recvBuf, recvBuf.length);
                        dnsRelaySocket.receive(inPacket);
                        byte[] queryData = Arrays.copyOf(inPacket.getData(), inPacket.getLength());
                        SocketAddress clientAddress = inPacket.getSocketAddress();

                        threadPool.execute(() -> forwardDnsQuery(queryData, clientAddress));
                    } catch (Exception e) {
                        if (!routerRunning.get()) break;
                    }
                }
            } catch (Exception ignored) {}
        });
    }

    private void forwardDnsQuery(byte[] queryData, SocketAddress clientAddress) {
        DatagramSocket upstreamSocket = null;
        try {
            upstreamSocket = new DatagramSocket();
            upstreamSocket.setSoTimeout(4000);

            Network upstreamNet = getActiveInternetNetwork();
            if (upstreamNet != null && Build.VERSION.SDK_INT >= 23) {
                upstreamNet.bindSocket(upstreamSocket);
            }

            InetAddress dnsServer = InetAddress.getByName("8.8.8.8");
            DatagramPacket outPacket = new DatagramPacket(queryData, queryData.length, dnsServer, 53);
            upstreamSocket.send(outPacket);

            byte[] respBuf = new byte[4096];
            DatagramPacket inPacket = new DatagramPacket(respBuf, respBuf.length);
            upstreamSocket.receive(inPacket);

            DatagramPacket replyPacket = new DatagramPacket(
                    inPacket.getData(), inPacket.getLength(), clientAddress
            );
            if (dnsRelaySocket != null && !dnsRelaySocket.isClosed()) {
                dnsRelaySocket.send(replyPacket);
            }
        } catch (Exception ignored) {
        } finally {
            if (upstreamSocket != null) {
                try { upstreamSocket.close(); } catch (Exception ignored) {}
            }
        }
    }

    private Network getActiveInternetNetwork() {
        if (Build.VERSION.SDK_INT < 23) return null;
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;

        for (Network net : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            if (caps != null &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) {
                return net;
            }
        }
        for (Network net : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                return net;
            }
        }
        return null;
    }

    private void handleConnection(Socket client) {
        try {
            BufferedInputStream in = new BufferedInputStream(client.getInputStream());
            in.mark(16);

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

    private void handleHttp(Socket client, BufferedInputStream in) throws Exception {
        ByteArrayOutputStream lineBuf = new ByteArrayOutputStream(256);
        String requestLine = readLine(in, lineBuf);
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

            String header;
            while ((header = readLine(in, lineBuf)) != null && !header.isEmpty()) {}

            Socket upstreamSocket = createUpstreamSocket(host, port);

            OutputStream clientOut = client.getOutputStream();
            clientOut.write("HTTP/1.1 200 Connection Established\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            clientOut.flush();

            bridgeSockets(client, in, upstreamSocket);
        } else {
            URL url;
            if (target.startsWith("http://") || target.startsWith("https://")) {
                url = new URL(target);
            } else {
                url = new URL("http://" + target);
            }
            host = url.getHost();
            port = url.getPort() != -1 ? url.getPort() : 80;

            Socket upstreamSocket = createUpstreamSocket(host, port);
            OutputStream remoteOut = upstreamSocket.getOutputStream();

            String rewrittenPath = url.getFile();
            if (rewrittenPath == null || rewrittenPath.isEmpty()) rewrittenPath = "/";
            String newRequestLine = method + " " + rewrittenPath + " " + (parts.length > 2 ? parts[2] : "HTTP/1.1") + "\r\n";
            remoteOut.write(newRequestLine.getBytes(StandardCharsets.UTF_8));

            String header;
            while ((header = readLine(in, lineBuf)) != null && !header.isEmpty()) {
                if (!header.toLowerCase().startsWith("proxy-connection:")) {
                    remoteOut.write((header + "\r\n").getBytes(StandardCharsets.UTF_8));
                }
            }
            remoteOut.write("\r\n".getBytes(StandardCharsets.UTF_8));
            remoteOut.flush();

            bridgeSockets(client, in, upstreamSocket);
        }
    }

    private static String readLine(InputStream in, ByteArrayOutputStream buf) throws Exception {
        buf.reset();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') buf.write(c);
        }
        if (c == -1 && buf.size() == 0) return null;
        return buf.toString("UTF-8");
    }

    private void handleSocks5(Socket client, BufferedInputStream in) throws Exception {
        OutputStream out = client.getOutputStream();
        int version = in.read();
        if (version != 5) {
            client.close();
            return;
        }
        int nmethods = in.read();
        byte[] methods = new byte[nmethods];
        in.read(methods);

        // Accept NO_AUTH (0x00)
        out.write(new byte[]{0x05, 0x00});
        out.flush();

        byte[] header = new byte[4];
        int hRead = in.read(header);
        if (hRead < 4) {
            client.close();
            return;
        }
        int cmd = header[1] & 0xFF;
        int atyp = header[3] & 0xFF;

        String targetHost;
        if (atyp == 0x01) {
            byte[] ipv4 = new byte[4];
            in.read(ipv4);
            targetHost = InetAddress.getByAddress(ipv4).getHostAddress();
        } else if (atyp == 0x03) {
            int domainLen = in.read();
            byte[] domain = new byte[domainLen];
            in.read(domain);
            targetHost = new String(domain, StandardCharsets.UTF_8);
        } else if (atyp == 0x04) {
            byte[] ipv6 = new byte[16];
            in.read(ipv6);
            targetHost = InetAddress.getByAddress(ipv6).getHostAddress();
        } else {
            client.close();
            return;
        }

        byte[] portBytes = new byte[2];
        in.read(portBytes);
        int targetPort = ((portBytes[0] & 0xFF) << 8) | (portBytes[1] & 0xFF);

        if (cmd == 0x01) {
            // SOCKS5 TCP CONNECT
            try {
                Socket upstreamSocket = createUpstreamSocket(targetHost, targetPort);
                byte[] resp = new byte[]{0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
                out.write(resp);
                out.flush();

                bridgeSockets(client, in, upstreamSocket);
            } catch (Exception e) {
                out.write(new byte[]{0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00});
                out.flush();
                client.close();
            }
        } else if (cmd == 0x03) {
            // SOCKS5 UDP ASSOCIATE (for voice/video calls, games, low-latency UDP streams)
            handleUdpAssociate(client, in, out);
        } else {
            // Command not supported
            out.write(new byte[]{0x05, 0x07, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00});
            out.flush();
            client.close();
        }
    }

    private void handleUdpAssociate(Socket clientTcp, BufferedInputStream in, OutputStream out) throws Exception {
        DatagramSocket hostUdpSocket = null;
        DatagramSocket upstreamUdpSocket = null;
        try {
            hostUdpSocket = new DatagramSocket(null);
            hostUdpSocket.setReuseAddress(true);
            hostUdpSocket.bind(new InetSocketAddress("0.0.0.0", 0));
            int boundPort = hostUdpSocket.getLocalPort();

            InetAddress localAddr = clientTcp.getLocalAddress();
            byte[] ipBytes;
            if (localAddr instanceof Inet4Address && !localAddr.isAnyLocalAddress()) {
                ipBytes = localAddr.getAddress();
            } else {
                ipBytes = new byte[]{(byte) 192, (byte) 168, (byte) 49, (byte) 1};
            }

            // SOCKS5 UDP ASSOCIATE SUCCESS reply
            byte[] reply = new byte[10];
            reply[0] = 0x05;
            reply[1] = 0x00;
            reply[2] = 0x00;
            reply[3] = 0x01;
            System.arraycopy(ipBytes, 0, reply, 4, 4);
            reply[8] = (byte) ((boundPort >> 8) & 0xFF);
            reply[9] = (byte) (boundPort & 0xFF);
            out.write(reply);
            out.flush();

            upstreamUdpSocket = new DatagramSocket();
            Network upstreamNet = getActiveInternetNetwork();
            if (upstreamNet != null && Build.VERSION.SDK_INT >= 23) {
                upstreamNet.bindSocket(upstreamUdpSocket);
            }

            final DatagramSocket finalHostUdp = hostUdpSocket;
            final DatagramSocket finalUpstreamUdp = upstreamUdpSocket;
            final AtomicBoolean associateActive = new AtomicBoolean(true);
            final AtomicReference<SocketAddress> clientUdpEndpoint = new AtomicReference<>();

            // Worker: Client -> Upstream
            threadPool.execute(() -> {
                byte[] buf = new byte[65535];
                while (associateActive.get() && routerRunning.get() && !finalHostUdp.isClosed()) {
                    try {
                        DatagramPacket packet = new DatagramPacket(buf, buf.length);
                        finalHostUdp.receive(packet);
                        clientUdpEndpoint.set(packet.getSocketAddress());

                        int len = packet.getLength();
                        byte[] data = packet.getData();
                        if (len <= 7 || data[0] != 0 || data[1] != 0) continue;
                        if (data[2] != 0) continue; // Fragment not supported

                        int atyp = data[3] & 0xFF;
                        int offset = 4;
                        InetAddress destAddr;
                        if (atyp == 0x01) {
                            if (len < offset + 4 + 2) continue;
                            byte[] ipv4 = Arrays.copyOfRange(data, offset, offset + 4);
                            destAddr = InetAddress.getByAddress(ipv4);
                            offset += 4;
                        } else if (atyp == 0x03) {
                            int dLen = data[offset] & 0xFF;
                            offset += 1;
                            if (len < offset + dLen + 2) continue;
                            String domain = new String(data, offset, dLen, StandardCharsets.UTF_8);
                            offset += dLen;
                            if (upstreamNet != null && Build.VERSION.SDK_INT >= 23) {
                                try {
                                    InetAddress[] addrs = upstreamNet.getAllByName(domain);
                                    destAddr = (addrs != null && addrs.length > 0) ? addrs[0] : InetAddress.getByName(domain);
                                } catch (Exception e) {
                                    destAddr = InetAddress.getByName(domain);
                                }
                            } else {
                                destAddr = InetAddress.getByName(domain);
                            }
                        } else if (atyp == 0x04) {
                            if (len < offset + 16 + 2) continue;
                            byte[] ipv6 = Arrays.copyOfRange(data, offset, offset + 16);
                            destAddr = InetAddress.getByAddress(ipv6);
                            offset += 16;
                        } else {
                            continue;
                        }

                        int destPort = ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
                        offset += 2;

                        int payloadLen = len - offset;
                        if (payloadLen > 0) {
                            DatagramPacket outPacket = new DatagramPacket(data, offset, payloadLen, destAddr, destPort);
                            finalUpstreamUdp.send(outPacket);
                            totalSentBytes.addAndGet(payloadLen);
                        }
                    } catch (Exception e) {
                        if (!associateActive.get()) break;
                    }
                }
            });

            // Worker: Upstream -> Client
            threadPool.execute(() -> {
                byte[] buf = new byte[65535];
                while (associateActive.get() && routerRunning.get() && !finalUpstreamUdp.isClosed()) {
                    try {
                        DatagramPacket packet = new DatagramPacket(buf, buf.length);
                        finalUpstreamUdp.receive(packet);

                        SocketAddress clientEp = clientUdpEndpoint.get();
                        if (clientEp == null) continue;

                        InetAddress remoteAddr = packet.getAddress();
                        int remotePort = packet.getPort();
                        byte[] payload = packet.getData();
                        int payloadLen = packet.getLength();

                        byte[] addrBytes = remoteAddr.getAddress();
                        int atyp = (addrBytes.length == 16) ? 0x04 : 0x01;

                        int headerLen = 4 + addrBytes.length + 2;
                        byte[] responsePacket = new byte[headerLen + payloadLen];
                        responsePacket[0] = 0x00;
                        responsePacket[1] = 0x00;
                        responsePacket[2] = 0x00;
                        responsePacket[3] = (byte) atyp;
                        System.arraycopy(addrBytes, 0, responsePacket, 4, addrBytes.length);
                        int pOff = 4 + addrBytes.length;
                        responsePacket[pOff] = (byte) ((remotePort >> 8) & 0xFF);
                        responsePacket[pOff + 1] = (byte) (remotePort & 0xFF);
                        System.arraycopy(payload, packet.getOffset(), responsePacket, headerLen, payloadLen);

                        DatagramPacket replyPacket = new DatagramPacket(responsePacket, responsePacket.length, clientEp);
                        finalHostUdp.send(replyPacket);
                        totalReceivedBytes.addAndGet(payloadLen);
                    } catch (Exception e) {
                        if (!associateActive.get()) break;
                    }
                }
            });

            // Wait for TCP control connection to close per RFC 1928
            byte[] dummy = new byte[128];
            while (routerRunning.get()) {
                int r = in.read(dummy);
                if (r == -1) break;
            }

            associateActive.set(false);
        } finally {
            if (hostUdpSocket != null) {
                try { hostUdpSocket.close(); } catch (Exception ignored) {}
            }
            if (upstreamUdpSocket != null) {
                try { upstreamUdpSocket.close(); } catch (Exception ignored) {}
            }
            try { clientTcp.close(); } catch (Exception ignored) {}
        }
    }

    private Socket createUpstreamSocket(String targetHost, int targetPort) throws Exception {
        Socket socket = new Socket();
        socket.setTcpNoDelay(true);
        socket.setKeepAlive(true);
        socket.setReceiveBufferSize(65536);
        socket.setSendBufferSize(65536);

        Network upstreamNet = getActiveInternetNetwork();
        if (upstreamNet != null && Build.VERSION.SDK_INT >= 23) {
            upstreamNet.bindSocket(socket);
        }

        InetAddress targetAddress;
        if (upstreamNet != null && Build.VERSION.SDK_INT >= 23) {
            try {
                InetAddress[] addrs = upstreamNet.getAllByName(targetHost);
                targetAddress = (addrs != null && addrs.length > 0) ? addrs[0] : InetAddress.getByName(targetHost);
            } catch (Exception e) {
                targetAddress = InetAddress.getByName(targetHost);
            }
        } else {
            targetAddress = InetAddress.getByName(targetHost);
        }

        socket.connect(new InetSocketAddress(targetAddress, targetPort), 10000);
        return socket;
    }

    private void bridgeSockets(Socket client, InputStream clientIn, Socket upstream) {
        AtomicBoolean active = new AtomicBoolean(true);

        threadPool.execute(() -> {
            byte[] buf = new byte[32768];
            try (OutputStream out = upstream.getOutputStream()) {
                int read;
                while (active.get() && (read = clientIn.read(buf)) != -1) {
                    out.write(buf, 0, read);
                    out.flush();
                    totalSentBytes.addAndGet(read);
                }
            } catch (Exception ignored) {
            } finally {
                active.set(false);
                closeSilently(client, upstream);
            }
        });

        threadPool.execute(() -> {
            byte[] buf = new byte[32768];
            try (InputStream in = upstream.getInputStream(); OutputStream out = client.getOutputStream()) {
                int read;
                while (active.get() && (read = in.read(buf)) != -1) {
                    out.write(buf, 0, read);
                    out.flush();
                    totalReceivedBytes.addAndGet(read);
                }
            } catch (Exception ignored) {
            } finally {
                active.set(false);
                closeSilently(client, upstream);
            }
        });
    }

    private void closeSilently(Socket s1, Socket s2) {
        try { s1.close(); } catch (Exception ignored) {}
        try { s2.close(); } catch (Exception ignored) {}
    }

    private synchronized void stopRouter() {
        routerRunning.set(false);
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (Exception ignored) {}
            serverSocket = null;
        }
        if (dnsRelaySocket != null) {
            try { dnsRelaySocket.close(); } catch (Exception ignored) {}
            dnsRelaySocket = null;
        }
        if (threadPool != null) {
            threadPool.shutdownNow();
            threadPool = null;
        }
    }

    @Override
    public void onDestroy() {
        NetworkWatcher.getInstance(this).stop();
        stopRouter();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
