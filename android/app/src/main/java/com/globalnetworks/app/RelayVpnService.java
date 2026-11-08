package com.globalnetworks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import java.io.FileInputStream;
import java.io.FileOutputStream;
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
    private ExecutorService executor;
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

        startForegroundNotification("Global Networks Auto-Router", "Active connection tunnel to relay host " + hostIp + ":" + hostPort);
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
        isRunning.set(true);

        try {
            Builder builder = new Builder();
            builder.setSession("Global Networks Client Router");
            builder.addAddress("10.8.0.2", 24);
            builder.addRoute("0.0.0.0", 0);
            builder.addDnsServer("8.8.8.8");
            builder.addDnsServer("1.1.1.1");
            builder.setMtu(1500);

            vpnInterface = builder.establish();
            if (vpnInterface == null) {
                isRunning.set(false);
                return;
            }

            executor = Executors.newCachedThreadPool();
            executor.execute(this::runTunReader);
        } catch (Exception e) {
            isRunning.set(false);
        }
    }

    private void runTunReader() {
        if (vpnInterface == null) return;
        try (FileInputStream in = new FileInputStream(vpnInterface.getFileDescriptor());
             FileOutputStream out = new FileOutputStream(vpnInterface.getFileDescriptor())) {
            byte[] buffer = new byte[32768];
            while (isRunning.get()) {
                int length = in.read(buffer);
                if (length <= 0) break;
            }
        } catch (Exception ignored) {}
    }

    private synchronized void stopVpn() {
        isRunning.set(false);
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        if (vpnInterface != null) {
            try { vpnInterface.close(); } catch (Exception ignored) {}
            vpnInterface = null;
        }
    }

    @Override
    public void onDestroy() {
        stopVpn();
        super.onDestroy();
    }
}
