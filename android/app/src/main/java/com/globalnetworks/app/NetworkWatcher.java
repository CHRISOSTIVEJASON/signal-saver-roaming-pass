package com.globalnetworks.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.TransportInfo;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Background Network Watcher ("Smeller"):
 * Continuously and sharply senses nearby Wi-Fi networks in range.
 * - If detected network is in the pool and user paid: connects automatically.
 * - If detected network is in the pool and user has not paid:
 *   plays a unique 3-second tone that beeps 3 times, posts a notification
 *   ("Network available, kindly consider paying."), and enforces a 20-minute cooldown.
 */
public class NetworkWatcher {
    private static final String TAG = "NetworkWatcher";
    private static final String PREFS_NAME = "gn_network_watcher";
    private static final String KEY_POOL_SSIDS = "pool_ssids";
    private static final String KEY_POOL_BSSIDS = "pool_bssids";
    private static final String KEY_HAS_ACTIVE_PASS = "has_active_pass";
    private static final String KEY_LAST_ALERT_TIME = "last_alert_time";
    private static final String KEY_LAST_DETECTED_SSID = "last_detected_ssid";
    private static final String KEY_BEEP_ALERTS_ENABLED = "beep_alerts_enabled";

    public static final long COOLDOWN_MS = 20 * 60 * 1000L; // 20 minutes cooldown
    public static final String NOTIFICATION_CHANNEL_ID = "gn_network_alert";

    private static volatile NetworkWatcher instance;

    private final Context context;
    private final SharedPreferences prefs;
    private final WifiManager wifiManager;
    private final ConnectivityManager connectivityManager;
    private final NotificationManager notificationManager;
    private final Handler mainHandler;

    private ScheduledExecutorService scheduler;
    private final AtomicBoolean isWatching = new AtomicBoolean(false);

    private BroadcastReceiver scanReceiver;
    private BroadcastReceiver networkReceiver;

    private volatile String currentNearbySsid = null;
    private volatile boolean nearbyPoolDetected = false;

    private NetworkWatcher(Context ctx) {
        this.context = ctx.getApplicationContext();
        this.prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        this.connectivityManager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        this.notificationManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        this.mainHandler = new Handler(Looper.getMainLooper());

        createNotificationChannel();
    }

    public static NetworkWatcher getInstance(Context ctx) {
        if (instance == null) {
            synchronized (NetworkWatcher.class) {
                if (instance == null) {
                    instance = new NetworkWatcher(ctx);
                }
            }
        }
        return instance;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26 && notificationManager != null) {
            NotificationChannel channel = new NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    "Signal Saver Network Alerts",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Alerts when a pool Wi-Fi network is detected nearby");
            channel.enableVibration(true);
            notificationManager.createNotificationChannel(channel);
        }
    }

    public synchronized void start() {
        if (isWatching.getAndSet(true)) {
            return;
        }
        Log.i(TAG, "Starting sharp background network watcher");

        registerReceivers();

        if (scheduler == null || scheduler.isShutdown()) {
            scheduler = Executors.newSingleThreadScheduledExecutor();
            // Sharp scanning loop: runs immediately, then every 15 seconds
            scheduler.scheduleWithFixedDelay(this::sniffNetworks, 2, 15, TimeUnit.SECONDS);
        }
    }

    public synchronized void stop() {
        if (!isWatching.getAndSet(false)) {
            return;
        }
        Log.i(TAG, "Stopping background network watcher");
        unregisterReceivers();
        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
        }
    }

    private void registerReceivers() {
        try {
            if (scanReceiver == null) {
                scanReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        mainHandler.post(() -> sniffNetworks());
                    }
                };
                IntentFilter scanFilter = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
                context.registerReceiver(scanReceiver, scanFilter);
            }

            if (networkReceiver == null) {
                networkReceiver = new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        mainHandler.post(() -> sniffNetworks());
                    }
                };
                IntentFilter netFilter = new IntentFilter();
                netFilter.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION);
                netFilter.addAction(ConnectivityManager.CONNECTIVITY_ACTION);
                context.registerReceiver(networkReceiver, netFilter);
            }
        } catch (Throwable t) {
            Log.w(TAG, "Error registering receivers: " + t.getMessage());
        }
    }

    private void unregisterReceivers() {
        try {
            if (scanReceiver != null) {
                context.unregisterReceiver(scanReceiver);
                scanReceiver = null;
            }
            if (networkReceiver != null) {
                context.unregisterReceiver(networkReceiver);
                networkReceiver = null;
            }
        } catch (Throwable ignored) {}
    }

    public void syncConfig(List<String> ssids, List<String> bssids, boolean hasActivePass) {
        syncConfig(ssids, bssids, hasActivePass, prefs.getBoolean(KEY_BEEP_ALERTS_ENABLED, true));
    }

    public void syncConfig(List<String> ssids, List<String> bssids, boolean hasActivePass, boolean soundAlerts) {
        Set<String> cleanSsids = new HashSet<>();
        if (ssids != null) {
            for (String s : ssids) {
                if (s != null && !s.trim().isEmpty()) {
                    cleanSsids.add(s.trim().toLowerCase(Locale.US));
                }
            }
        }

        Set<String> cleanBssids = new HashSet<>();
        if (bssids != null) {
            for (String b : bssids) {
                if (b != null && !b.trim().isEmpty()) {
                    cleanBssids.add(b.trim().toUpperCase(Locale.US));
                }
            }
        }

        prefs.edit()
                .putStringSet(KEY_POOL_SSIDS, cleanSsids)
                .putStringSet(KEY_POOL_BSSIDS, cleanBssids)
                .putBoolean(KEY_HAS_ACTIVE_PASS, hasActivePass)
                .putBoolean(KEY_BEEP_ALERTS_ENABLED, soundAlerts)
                .apply();

        Log.i(TAG, "Config synced: " + cleanSsids.size() + " SSIDs, " + cleanBssids.size() + " BSSIDs, activePass=" + hasActivePass);

        // Immediate check with new config
        if (scheduler != null && !scheduler.isShutdown()) {
            scheduler.execute(this::sniffNetworks);
        }
    }

    public Set<String> getPoolSsids() {
        return prefs.getStringSet(KEY_POOL_SSIDS, Collections.emptySet());
    }

    public Set<String> getPoolBssids() {
        return prefs.getStringSet(KEY_POOL_BSSIDS, Collections.emptySet());
    }

    public boolean hasActivePass() {
        return prefs.getBoolean(KEY_HAS_ACTIVE_PASS, false);
    }

    public String getCurrentNearbySsid() {
        return currentNearbySsid;
    }

    public boolean isNearbyPoolDetected() {
        return nearbyPoolDetected;
    }

    /**
     * Sharp keen watcher: smells any pinch of network matching the pool or relay.
     */
    public void sniffNetworks() {
        try {
            if (wifiManager == null) return;

            // Trigger active scan request if Wi-Fi is enabled
            if (wifiManager.isWifiEnabled()) {
                try {
                    wifiManager.startScan();
                } catch (Throwable ignored) {}
            }

            Set<String> poolSsids = getPoolSsids();
            Set<String> poolBssids = getPoolBssids();

            String detectedSsid = null;
            String detectedBssid = null;
            int bestSignal = -999;

            // 1. Inspect live Wi-Fi scan results in the air
            List<ScanResult> results = null;
            try {
                results = wifiManager.getScanResults();
            } catch (SecurityException se) {
                Log.w(TAG, "Scan permission not granted: " + se.getMessage());
            }

            if (results != null) {
                for (ScanResult sr : results) {
                    if (sr == null) continue;
                    String s = sr.SSID != null ? sr.SSID.replace("\"", "").trim() : "";
                    String b = sr.BSSID != null ? sr.BSSID.trim().toUpperCase(Locale.US) : "";

                    boolean matchSsid = !s.isEmpty() && poolSsids.contains(s.toLowerCase(Locale.US));
                    boolean matchBssid = !b.isEmpty() && poolBssids.contains(b);

                    if (matchSsid || matchBssid) {
                        if (sr.level > bestSignal) {
                            bestSignal = sr.level;
                            detectedSsid = s.isEmpty() ? b : s;
                            detectedBssid = b;
                        }
                    }
                }
            }

            // 2. Check currently connected Wi-Fi
            String connSsid = getConnectedSsid();
            String connBssid = getConnectedBssid();
            if (connSsid != null || connBssid != null) {
                boolean matchSsid = connSsid != null && poolSsids.contains(connSsid.toLowerCase(Locale.US));
                boolean matchBssid = connBssid != null && poolBssids.contains(connBssid.toUpperCase(Locale.US));
                if (matchSsid || matchBssid) {
                    detectedSsid = connSsid != null ? connSsid : connBssid;
                    detectedBssid = connBssid;
                }
            }

            // 3. Check active Wi-Fi Direct Mesh Relay
            if (detectedSsid == null && RelayService.isRouterRunning()) {
                detectedSsid = "Global Mesh Relay";
            }

            if (detectedSsid != null) {
                currentNearbySsid = detectedSsid;
                nearbyPoolDetected = true;
                handleNetworkSensed(detectedSsid, detectedBssid);
            } else {
                currentNearbySsid = null;
                nearbyPoolDetected = false;
            }
        } catch (Throwable t) {
            Log.e(TAG, "Error sniffing networks", t);
        }
    }

    private void handleNetworkSensed(String ssid, String bssid) {
        boolean active = hasActivePass();
        Log.i(TAG, "Smelled network in range: " + ssid + " (activePass=" + active + ")");

        prefs.edit().putString(KEY_LAST_DETECTED_SSID, ssid).apply();

        if (active) {
            // User paid and countdown is active: auto-connect!
            suggestNetworkToAndroid(ssid);
        } else {
            // User has NOT paid: alert with unique 3-second 3-beep tone and notification
            long lastAlert = prefs.getLong(KEY_LAST_ALERT_TIME, 0);
            long now = System.currentTimeMillis();

            if (now - lastAlert >= COOLDOWN_MS || lastAlert == 0) {
                prefs.edit().putLong(KEY_LAST_ALERT_TIME, now).apply();

                // 1. Play unique 3-second tone that beeps 3 times (if sound enabled)
                if (prefs.getBoolean(KEY_BEEP_ALERTS_ENABLED, true)) {
                    playUniqueThreeBeepTone();
                }

                // 2. Post alert notification
                postNetworkAvailableNotification(ssid);

                Log.i(TAG, "Beep tone and alert triggered for: " + ssid);
            } else {
                long remainingMin = (COOLDOWN_MS - (now - lastAlert)) / (60 * 1000);
                Log.d(TAG, "Network " + ssid + " available. Alert in cooldown (" + remainingMin + "m remaining)");
            }
        }
    }

    /**
     * Unique 3-second tone that beeps 3 times:
     * Beep 1: 350ms tone
     * Pause: 500ms
     * Beep 2: 350ms tone
     * Pause: 500ms
     * Beep 3: 350ms tone
     * Total span: ~2.6 to 3 seconds.
     */
    public static void playUniqueThreeBeepTone() {
        new Thread(() -> {
            ToneGenerator tg = null;
            try {
                tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 100);
                for (int i = 0; i < 3; i++) {
                    tg.startTone(ToneGenerator.TONE_PROP_BEEP2, 350);
                    Thread.sleep(850);
                }
            } catch (Throwable t) {
                Log.w(TAG, "ToneGenerator error: " + t.getMessage());
            } finally {
                if (tg != null) {
                    try {
                        tg.release();
                    } catch (Throwable ignored) {}
                }
            }
        }).start();
    }

    private void postNetworkAvailableNotification(String ssid) {
        try {
            if (notificationManager == null) return;

            Intent intent = new Intent(context, MainActivity.class);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pendingIntent = PendingIntent.getActivity(context, 2026, intent, flags);

            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(context, NOTIFICATION_CHANNEL_ID)
                    : new Notification.Builder(context);

            builder.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                    .setContentTitle("Network Available")
                    .setContentText("Network available, kindly consider paying.")
                    .setStyle(new Notification.BigTextStyle().bigText("Network available, kindly consider paying.\nSensed \"" + ssid + "\" nearby. Tap to open Signal Saver and unlock your pass."))
                    .setContentIntent(pendingIntent)
                    .setAutoCancel(true)
                    .setPriority(Notification.PRIORITY_HIGH);

            notificationManager.notify(2026, builder.build());
        } catch (Throwable t) {
            Log.w(TAG, "Failed to post notification: " + t.getMessage());
        }
    }

    private void suggestNetworkToAndroid(String ssid) {
        if (Build.VERSION.SDK_INT >= 29 && wifiManager != null && ssid != null && !ssid.isEmpty() && !ssid.equals("Global Mesh Relay")) {
            try {
                WifiNetworkSuggestion suggestion = new WifiNetworkSuggestion.Builder()
                        .setSsid(ssid)
                        .setIsAppInteractionRequired(false)
                        .build();
                wifiManager.addNetworkSuggestions(Collections.singletonList(suggestion));
            } catch (Throwable ignored) {}
        }
    }

    private String getConnectedSsid() {
        if (connectivityManager != null && Build.VERSION.SDK_INT >= 29) {
            try {
                Network net = connectivityManager.getActiveNetwork();
                if (net != null) {
                    NetworkCapabilities caps = connectivityManager.getNetworkCapabilities(net);
                    if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                        TransportInfo ti = caps.getTransportInfo();
                        if (ti instanceof WifiInfo) {
                            String s = ((WifiInfo) ti).getSSID();
                            if (s != null && !s.equals("<unknown ssid>")) {
                                return s.replace("\"", "").trim();
                            }
                        }
                    }
                }
            } catch (Throwable ignored) {}
        }

        if (wifiManager != null) {
            try {
                WifiInfo info = wifiManager.getConnectionInfo();
                if (info != null) {
                    String s = info.getSSID();
                    if (s != null && !s.equals("<unknown ssid>")) {
                        return s.replace("\"", "").trim();
                    }
                }
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private String getConnectedBssid() {
        if (connectivityManager != null && Build.VERSION.SDK_INT >= 29) {
            try {
                Network net = connectivityManager.getActiveNetwork();
                if (net != null) {
                    NetworkCapabilities caps = connectivityManager.getNetworkCapabilities(net);
                    if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                        TransportInfo ti = caps.getTransportInfo();
                        if (ti instanceof WifiInfo) {
                            String b = ((WifiInfo) ti).getBSSID();
                            if (b != null && !b.equals("02:00:00:00:00:00")) {
                                return b.trim();
                            }
                        }
                    }
                }
            } catch (Throwable ignored) {}
        }

        if (wifiManager != null) {
            try {
                WifiInfo info = wifiManager.getConnectionInfo();
                if (info != null) {
                    String b = info.getBSSID();
                    if (b != null && !b.equals("02:00:00:00:00:00")) {
                        return b.trim();
                    }
                }
            } catch (Throwable ignored) {}
        }
        return null;
    }
}
