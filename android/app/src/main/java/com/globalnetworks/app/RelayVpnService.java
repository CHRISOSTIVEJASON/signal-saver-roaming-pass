package com.globalnetworks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicBoolean;

import hev.sockstun.TProxyService;

public class RelayVpnService extends VpnService {
    private static final String TAG = "RelayVpnService";
    public static final String ACTION_START_CLIENT = "com.globalnetworks.app.START_CLIENT_VPN";
    public static final String ACTION_STOP_CLIENT = "com.globalnetworks.app.STOP_CLIENT_VPN";
    public static final String EXTRA_HOST_IP = "extra_host_ip";
    public static final String EXTRA_HOST_PORT = "extra_host_port";

    private static final AtomicBoolean isRunning = new AtomicBoolean(false);
    private ParcelFileDescriptor vpnInterface;
    private String hostIp = "192.168.49.1";
    private int hostPort = 8282;

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

        if ("192.168.49.1".equals(hostIp)) {
            try {
                android.net.wifi.WifiManager wm = (android.net.wifi.WifiManager) getApplicationContext().getSystemService(android.content.Context.WIFI_SERVICE);
                if (wm != null) {
                    android.net.DhcpInfo dhcp = wm.getDhcpInfo();
                    if (dhcp != null && dhcp.gateway != 0) {
                        String detectedGw = android.text.format.Formatter.formatIpAddress(dhcp.gateway);
                        if (detectedGw != null && !detectedGw.equals("0.0.0.0")) {
                            hostIp = detectedGw;
                        }
                    }
                }
            } catch (Throwable ignored) {}
        }

        startForegroundNotification("Global Networks Dual-Path Tunnel", "Native TUN engine (lwIP/tun2socks) active to " + hostIp + ":" + hostPort);
        startVpnTunnel();
        return START_STICKY;
    }

    private void startForegroundNotification(String title, String text) {
        try {
            String channelId = "global-networks-vpn";
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
                if (nm != null) {
                    NotificationChannel nc = new NotificationChannel(channelId, "Global Networks Client Tunnel", NotificationManager.IMPORTANCE_LOW);
                    nm.createNotificationChannel(nc);
                }
            }
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, channelId) : new Notification.Builder(this);
            int appIcon = getApplicationInfo().icon != 0 ? getApplicationInfo().icon : android.R.drawable.ic_dialog_info;
            builder.setSmallIcon(appIcon)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setOngoing(true);
            startForeground(2, builder.build());
        } catch (Throwable t) {
            Log.w(TAG, "VPN foreground notification could not be started", t);
        }
    }

    private synchronized void startVpnTunnel() {
        if (isRunning.get()) return;

        // Native engine availability check
        if (!TProxyService.isLoaded()) {
            Log.w(TAG, "Native tun2socks engine library (libhev-socks5-tunnel.so) is not bundled or loaded on this device ABI; skipping VPN tunnel capture to prevent blackholing packets. Direct SOCKS5 proxy at " + hostIp + ":" + hostPort + " remains available.");
            stopForeground(true);
            stopSelf();
            return;
        }

        try {
            Builder builder = new Builder();
            builder.setSession("Global Networks Client Router");
            builder.addAddress("10.8.0.2", 24);

            // Dual-path tunnel: Route all device TCP and UDP packets through the TUN interface
            builder.addRoute("0.0.0.0", 0);
            builder.addDnsServer("8.8.8.8");
            builder.addDnsServer("1.1.1.1");
            // MTU 1400: Prevents packet fragmentation over Wi-Fi Direct and VPN encapsulation for smooth video streaming
            builder.setMtu(1400);

            try {
                builder.addDisallowedApplication(getPackageName());
            } catch (Exception ignored) {}

            vpnInterface = builder.establish();
            if (vpnInterface == null) {
                Log.e(TAG, "Failed to establish VPN interface");
                return;
            }

            // Create hev-socks5-tunnel config file
            File configFile = new File(getFilesDir(), "hev-tun.yml");
            String configYaml =
                    "misc:\n" +
                    "  task-stack-size: 81920\n" +
                    "  connect-timeout: 10000\n" +
                    "tunnel:\n" +
                    "  name: tun0\n" +
                    "  mtu: 1400\n" +
                    "  ipv4: 10.8.0.2\n" +
                    "socks5:\n" +
                    "  port: " + hostPort + "\n" +
                    "  address: '" + hostIp + "'\n" +
                    "  udp: 'udp'\n" +
                    "mapdns:\n" +
                    "  address: 10.8.0.1\n" +
                    "  port: 53\n" +
                    "  network: 240.0.0.0\n" +
                    "  netmask: 240.0.0.0\n" +
                    "  cache-size: 4096\n";

            try (FileOutputStream fos = new FileOutputStream(configFile)) {
                fos.write(configYaml.getBytes(StandardCharsets.UTF_8));
            }

            Log.i(TAG, "Starting native tun2socks engine with fd=" + vpnInterface.getFd());
            if (TProxyService.isLoaded()) {
                TProxyService.TProxyStartService(configFile.getAbsolutePath(), vpnInterface.getFd());
                isRunning.set(true);
            } else {
                Log.w(TAG, "Native tun2socks engine not loaded, skipping native hook");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting native VPN tunnel", e);
            stopVpn();
        }
    }

    private synchronized void stopVpn() {
        if (!isRunning.get() && vpnInterface == null) return;
        isRunning.set(false);
        try {
            TProxyService.TProxyStopService();
        } catch (Exception ignored) {}

        if (vpnInterface != null) {
            try {
                vpnInterface.close();
            } catch (Exception ignored) {}
            vpnInterface = null;
        }
    }

    @Override
    public void onDestroy() {
        stopVpn();
        super.onDestroy();
    }

    @Override
    public void onRevoke() {
        stopVpn();
        stopForeground(true);
        stopSelf();
        super.onRevoke();
    }
}
