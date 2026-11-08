package com.globalnetworks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.ProxyInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class RelayVpnService extends VpnService {
    public static final String ACTION_START_CLIENT = "com.globalnetworks.app.START_CLIENT_VPN";
    public static final String ACTION_STOP_CLIENT = "com.globalnetworks.app.STOP_CLIENT_VPN";
    public static final String EXTRA_HOST_IP = "extra_host_ip";
    public static final String EXTRA_HOST_PORT = "extra_host_port";

    private static final AtomicBoolean isRunning = new AtomicBoolean(false);
    private ParcelFileDescriptor vpnInterface;
    private FileOutputStream tunOut;
    private final Object tunLock = new Object();
    private ExecutorService executor;
    private DatagramSocket dnsClientUdp;
    private String hostIp = "192.168.49.1";
    private int hostPort = 8282;

    private static class PendingDnsQuery {
        final byte[] origSrcIp;
        final byte[] origDstIp;
        final int srcPort;
        final long timestamp;

        PendingDnsQuery(byte[] origSrcIp, byte[] origDstIp, int srcPort) {
            this.origSrcIp = origSrcIp;
            this.origDstIp = origDstIp;
            this.srcPort = srcPort;
            this.timestamp = System.currentTimeMillis();
        }
    }

    private final Map<Integer, PendingDnsQuery> pendingQueries = new ConcurrentHashMap<>();

    public static boolean isVpnRunning() {
        return isRunning.get();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_STOP_CLIENT.equals(action)) {
            stopVpn();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (intent != null && intent.hasExtra(EXTRA_HOST_IP)) {
            String ip = intent.getStringExtra(EXTRA_HOST_IP);
            if (ip != null && !ip.isEmpty()) {
                hostIp = ip;
            }
        }
        if (intent != null && intent.hasExtra(EXTRA_HOST_PORT)) {
            hostPort = intent.getIntExtra(EXTRA_HOST_PORT, 8282);
        }

        startForegroundNotification("Global Networks Auto-Router", "Active relay & DNS tunnel to host " + hostIp + ":" + hostPort);
        startVpnTunnel();
        return START_STICKY;
    }

    private void startForegroundNotification(String title, String text) {
        String channelId = "global-networks-vpn";
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) {
                NotificationChannel nc = new NotificationChannel(channelId, "Global Networks Client Tunnel", NotificationManager.IMPORTANCE_LOW);
                nm.createNotificationChannel(nc);
            }
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channelId) : new Notification.Builder(this);
        builder.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true);
        startForeground(2, builder.build());
    }

    private synchronized void startVpnTunnel() {
        if (isRunning.get()) return;

        try {
            Builder builder = new Builder();
            builder.setSession("Global Networks Client Router");
            builder.addAddress("10.8.0.2", 24);

            // Intercept internal subnet and popular DNS servers directly
            builder.addRoute("10.8.0.0", 24);
            builder.addRoute("8.8.8.8", 32);
            builder.addRoute("8.8.4.4", 32);
            builder.addRoute("1.1.1.1", 32);
            builder.addRoute("1.0.0.1", 32);

            builder.addDnsServer("10.8.0.1");
            builder.addDnsServer("8.8.8.8");
            builder.addDnsServer("1.1.1.1");
            builder.setMtu(1500);

            try {
                builder.addDisallowedApplication(getPackageName());
            } catch (Exception ignored) {}

            if (Build.VERSION.SDK_INT >= 29) {
                builder.setHttpProxy(ProxyInfo.buildDirectProxy(hostIp, hostPort));
            }

            vpnInterface = builder.establish();
            if (vpnInterface == null) {
                return;
            }

            tunOut = new FileOutputStream(vpnInterface.getFileDescriptor());

            // Protected UDP socket to query host's DNS relay without looping into VPN
            dnsClientUdp = new DatagramSocket();
            protect(dnsClientUdp);

            isRunning.set(true);
            executor = Executors.newCachedThreadPool();
            executor.execute(this::runTunReader);
            executor.execute(this::runDnsResponseReceiver);
        } catch (Exception e) {
            isRunning.set(false);
        }
    }

    private void runTunReader() {
        if (vpnInterface == null) return;
        try (FileInputStream in = new FileInputStream(vpnInterface.getFileDescriptor())) {
            byte[] buffer = new byte[32768];
            while (isRunning.get()) {
                int length = in.read(buffer);
                if (length <= 0) break;

                // Process IPv4 packets
                if ((buffer[0] >> 4) == 4 && length >= 20) {
                    int ihl = (buffer[0] & 0x0F) * 4;
                    int proto = buffer[9] & 0xFF;

                    if (proto == 17 && length >= ihl + 8) { // UDP
                        int srcPort = ((buffer[ihl] & 0xFF) << 8) | (buffer[ihl + 1] & 0xFF);
                        int dstPort = ((buffer[ihl + 2] & 0xFF) << 8) | (buffer[ihl + 3] & 0xFF);
                        int udpLen = ((buffer[ihl + 4] & 0xFF) << 8) | (buffer[ihl + 5] & 0xFF);

                        if (dstPort == 53 && udpLen >= 8 && length >= ihl + udpLen) {
                            byte[] dnsQuery = Arrays.copyOfRange(buffer, ihl + 8, ihl + udpLen);
                            if (dnsQuery.length >= 2) {
                                int queryId = ((dnsQuery[0] & 0xFF) << 8) | (dnsQuery[1] & 0xFF);
                                byte[] origSrcIp = Arrays.copyOfRange(buffer, 12, 16);
                                byte[] origDstIp = Arrays.copyOfRange(buffer, 16, 20);

                                pendingQueries.put(queryId, new PendingDnsQuery(origSrcIp, origDstIp, srcPort));

                                // Forward DNS query to host relay
                                executor.execute(() -> {
                                    try {
                                        InetAddress hostAddr = InetAddress.getByName(hostIp);
                                        DatagramPacket packet = new DatagramPacket(
                                                dnsQuery, dnsQuery.length, hostAddr, RelayService.DNS_RELAY_PORT
                                        );
                                        if (dnsClientUdp != null && !dnsClientUdp.isClosed()) {
                                            dnsClientUdp.send(packet);
                                        }
                                    } catch (Exception ignored) {}
                                });
                            }
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void runDnsResponseReceiver() {
        byte[] recvBuf = new byte[4096];
        while (isRunning.get() && dnsClientUdp != null && !dnsClientUdp.isClosed()) {
            try {
                DatagramPacket packet = new DatagramPacket(recvBuf, recvBuf.length);
                dnsClientUdp.receive(packet);

                if (packet.getLength() >= 2) {
                    byte[] dnsResp = Arrays.copyOf(packet.getData(), packet.getLength());
                    int queryId = ((dnsResp[0] & 0xFF) << 8) | (dnsResp[1] & 0xFF);

                    PendingDnsQuery orig = pendingQueries.remove(queryId);
                    if (orig != null) {
                        byte[] ipPacket = buildUdpIpPacket(orig.origDstIp, orig.origSrcIp, 53, orig.srcPort, dnsResp);
                        synchronized (tunLock) {
                            if (tunOut != null) {
                                tunOut.write(ipPacket);
                                tunOut.flush();
                            }
                        }
                    }
                }
            } catch (Exception e) {
                if (!isRunning.get()) break;
            }
        }
    }

    private byte[] buildUdpIpPacket(byte[] srcIp, byte[] dstIp, int srcPort, int dstPort, byte[] payload) {
        int udpLen = 8 + payload.length;
        int ipLen = 20 + udpLen;

        byte[] packet = new byte[ipLen];
        ByteBuffer bb = ByteBuffer.wrap(packet);

        // IPv4 Header (20 bytes)
        bb.put((byte) 0x45); // Version 4, IHL 5
        bb.put((byte) 0x00); // DSCP/ECN
        bb.putShort((short) ipLen);
        bb.putShort((short) 0); // Identification
        bb.putShort((short) 0x4000); // Flags: Don't Fragment
        bb.put((byte) 64); // TTL
        bb.put((byte) 17); // Protocol: UDP
        bb.putShort((short) 0); // Checksum placeholder
        bb.put(srcIp);
        bb.put(dstIp);

        // Compute IP Checksum
        short ipChecksum = computeChecksum(packet, 0, 20);
        packet[10] = (byte) ((ipChecksum >> 8) & 0xFF);
        packet[11] = (byte) (ipChecksum & 0xFF);

        // UDP Header (8 bytes)
        bb.position(20);
        bb.putShort((short) srcPort);
        bb.putShort((short) dstPort);
        bb.putShort((short) udpLen);
        bb.putShort((short) 0); // UDP Checksum (0 = optional in IPv4)

        // Payload
        bb.put(payload);

        return packet;
    }

    private short computeChecksum(byte[] buf, int offset, int length) {
        int sum = 0;
        int i = offset;
        while (length > 1) {
            sum += ((buf[i] & 0xFF) << 8) | (buf[i + 1] & 0xFF);
            i += 2;
            length -= 2;
        }
        if (length > 0) {
            sum += (buf[i] & 0xFF) << 8;
        }
        while ((sum >> 16) > 0) {
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        return (short) (~sum & 0xFFFF);
    }

    private synchronized void stopVpn() {
        isRunning.set(false);
        if (dnsClientUdp != null) {
            try { dnsClientUdp.close(); } catch (Exception ignored) {}
            dnsClientUdp = null;
        }
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        synchronized (tunLock) {
            if (tunOut != null) {
                try { tunOut.close(); } catch (Exception ignored) {}
                tunOut = null;
            }
        }
        if (vpnInterface != null) {
            try { vpnInterface.close(); } catch (Exception ignored) {}
            vpnInterface = null;
        }
        pendingQueries.clear();
    }

    @Override
    public void onDestroy() {
        stopVpn();
        super.onDestroy();
    }
}
