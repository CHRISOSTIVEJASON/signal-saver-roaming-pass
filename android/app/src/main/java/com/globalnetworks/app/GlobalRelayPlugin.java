package com.globalnetworks.app;

import android.util.Log;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.VpnService;
import android.net.wifi.WifiManager;
import android.net.wifi.aware.PublishDiscoverySession;
import android.net.wifi.aware.WifiAwareSession;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pGroup;
import android.net.wifi.p2p.WifiP2pInfo;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceInfo;
import android.os.Build;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.JSArray;
import java.util.List;
import java.util.Iterator;
import java.util.ArrayList;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import android.os.Handler;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;

@CapacitorPlugin(name="GlobalRelay", permissions={
    @Permission(alias="location", strings={Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}),
    @Permission(alias="nearby", strings={"android.permission.NEARBY_WIFI_DEVICES"}),
    @Permission(alias="notifications", strings={Manifest.permission.POST_NOTIFICATIONS})
})
public class GlobalRelayPlugin extends Plugin {
    private static volatile GlobalRelayPlugin activeInstance;

    public static GlobalRelayPlugin getInstance() {
        return activeInstance;
    }

    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private WifiAwareSession awareSession;
    private PublishDiscoverySession publication;
    private BroadcastReceiver receiver;
    private ConnectivityManager.NetworkCallback autoRelayCallback;
    private boolean started = false;
    private boolean upstream = false;
    private JSObject relay;
    private final String networkName = "DIRECT-GLOBAL-NETWORKS";
    private final ExecutorService portalExecutor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        activeInstance = this;
        manager = (WifiP2pManager) getContext().getSystemService(Context.WIFI_P2P_SERVICE);
        if (manager != null) {
            channel = manager.initialize(getContext(), Looper.getMainLooper(), null);
        }
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent i) {
                if (granted()) refreshGroup();
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    private void registerAutoRelayCallback() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= 24) {
                NetworkRequest req = new NetworkRequest.Builder()
                        .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build();
                autoRelayCallback = new ConnectivityManager.NetworkCallback() {
                    @Override
                    public void onAvailable(Network network) {
                        autoStartRelayHost();
                    }

                    @Override
                    public void onLost(Network network) {
                    }
                };
                cm.registerNetworkCallback(req, autoRelayCallback);
            }
        } catch (Exception ignored) {}
    }

    private void autoStartRelayHost() {
        try {
            Intent serviceIntent = new Intent(getContext(), RelayService.class);
            serviceIntent.setAction(RelayService.ACTION_START_HOST);
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(serviceIntent);
            } else {
                getContext().startService(serviceIntent);
            }
        } catch (Exception ignored) {}
    }

    private boolean granted() {
        boolean locationOk = getPermissionState("location") == PermissionState.GRANTED;
        boolean nearbyOk = Build.VERSION.SDK_INT < 33 || getPermissionState("nearby") == PermissionState.GRANTED;
        boolean notifOk = Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED;
        return locationOk && nearbyOk && notifOk;
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (granted()) {
            accessResult(call);
            return;
        }
        requestPermissionForAliases(
            Build.VERSION.SDK_INT >= 33 ? new String[]{"location", "nearby", "notifications"} : new String[]{"location"},
            call,
            "accessResult"
        );
    }

    @PermissionCallback
    private void accessResult(PluginCall call) {
        JSObject result = new JSObject();
        result.put("granted", granted());
        call.resolve(result);
        emit();
    }

    @PluginMethod
    public void checkMandatoryPermission(PluginCall call) {
        JSObject result = new JSObject();
        boolean hasAccess = granted();
        Intent vpnIntent = VpnService.prepare(getContext());
        boolean vpnPrepared = (vpnIntent == null);

        result.put("granted", hasAccess);
        result.put("vpnPrepared", vpnPrepared);
        result.put("ready", hasAccess && vpnPrepared);

        if (!vpnPrepared && getActivity() != null) {
            try {
                getActivity().startActivityForResult(vpnIntent, 101);
            } catch (Exception ignored) {}
        }
        call.resolve(result);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                String packageName = getContext().getPackageName();
                PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(packageName)) {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + packageName));
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(intent);
                }
            }
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void openHotspotSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Intent.ACTION_MAIN);
            intent.setClassName("com.android.settings", "com.android.settings.TetherSettings");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_WIRELESS_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            } catch (Exception ignored) {}
        }
        call.resolve();
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        getActivity().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())));
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        if (granted()) refreshGroup();
        call.resolve(state());
    }

    private JSObject state() {
        JSObject result = new JSObject();
        boolean hasAccess = granted();
        result.put("granted", hasAccess);

        String ssid = null;
        String bssid = null;

        if (hasAccess) {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null && Build.VERSION.SDK_INT >= 29) {
                try {
                    Network net = cm.getActiveNetwork();
                    if (net != null) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            android.net.TransportInfo transportInfo = caps.getTransportInfo();
                            if (transportInfo instanceof android.net.wifi.WifiInfo) {
                                android.net.wifi.WifiInfo winfo = (android.net.wifi.WifiInfo) transportInfo;
                                String s = winfo.getSSID();
                                if (s != null && !s.equals("<unknown ssid>")) {
                                    ssid = s.replace(String.valueOf('"'), "");
                                }
                                String b = winfo.getBSSID();
                                if (b != null && !b.equals("02:00:00:00:00:00")) {
                                    bssid = b;
                                }
                            }
                        }
                    }
                } catch (Exception ignored) {}
            }

            if (ssid == null || bssid == null) {
                try {
                    WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                    if (wifi != null) {
                        android.net.wifi.WifiInfo info = wifi.getConnectionInfo();
                        if (info != null) {
                            String s = info.getSSID();
                            if (s != null && !s.equals("<unknown ssid>")) {
                                if (ssid == null) ssid = s.replace(String.valueOf('"'), "");
                            }
                            String b = info.getBSSID();
                            if (b != null && !b.equals("02:00:00:00:00:00")) {
                                if (bssid == null) bssid = b;
                            }
                        }
                    }
                } catch (Exception ignored) {}
            }
        }

        if (ssid != null && bssid == null) {
            bssid = "GN:" + Integer.toHexString(Math.abs(ssid.hashCode())).toUpperCase();
        }

        if (ssid != null) result.put("ssid", ssid);
        if (bssid != null) result.put("bssid", bssid);
        if (relay != null) result.put("relay", relay);

        try {
            NetworkWatcher watcher = NetworkWatcher.getInstance(getContext());
            result.put("nearbyPoolDetected", watcher.isNearbyPoolDetected());
            if (watcher.getCurrentNearbySsid() != null) {
                result.put("nearbySsid", watcher.getCurrentNearbySsid());
            }
            if (watcher.getLastAuthFailedSsid() != null) {
                result.put("authFailedSsid", watcher.getLastAuthFailedSsid());
            }
        } catch (Throwable ignored) {}

        return result;
    }

    private void emit() {
        notifyListeners("stateChanged", state());
    }

    private WifiP2pManager.ActionListener action() {
        return new WifiP2pManager.ActionListener() {
            public void onSuccess() {
                refreshGroup();
            }
            public void onFailure(int reason) {
                JSObject error = new JSObject();
                error.put("code", reason);
                notifyListeners("relayError", error);
            }
        };
    }

    @PluginMethod
    public void start(PluginCall call) {
        upstream = call.getBoolean("upstreamInPool", false);
        if (!granted()) {
            call.reject("Nearby Wi-Fi and location access are required");
            return;
        }
        if (manager == null || channel == null) {
            call.reject("Wi-Fi Direct is not supported");
            return;
        }
        if (started) {
            refreshGroup();
            call.resolve();
            return;
        }
        started = true;

        autoStartRelayHost();

        Map<String, String> record = new HashMap<>();
        record.put("identity", networkName);
        record.put("uplink", String.valueOf(upstream));
        manager.addLocalService(channel, WifiP2pDnsSdServiceInfo.newInstance("GLOBAL-NETWORKS", "_globalnetworks._tcp", record), action());
        manager.setDnsSdResponseListeners(channel, (instance, type, device) -> {
            if (!upstream && instance.equals("GLOBAL-NETWORKS")) {
                WifiP2pConfig config = new WifiP2pConfig();
                config.deviceAddress = device.deviceAddress;
                manager.connect(channel, config, action());
            }
        }, (domain, txt, device) -> {});
        manager.addServiceRequest(channel, android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest.newInstance(), action());
        manager.discoverServices(channel, action());
        if (upstream) manager.createGroup(channel, action());
        refreshGroup();
        call.resolve();
    }

    @PluginMethod
    public void startClientAutoRouter(PluginCall call) {
        String host = call.getString("hostIp");
        if (host == null || host.isEmpty() || "192.168.49.1".equals(host)) {
            try {
                WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    android.net.DhcpInfo dhcp = wm.getDhcpInfo();
                    if (dhcp != null && dhcp.gateway != 0) {
                        String detectedGw = android.text.format.Formatter.formatIpAddress(dhcp.gateway);
                        if (detectedGw != null && !detectedGw.equals("0.0.0.0")) {
                            host = detectedGw;
                        }
                    }
                }
            } catch (Throwable ignored) {}
        }
        if (host == null || host.isEmpty()) {
            host = "192.168.49.1";
        }
        int port = call.getInt("hostPort", 8282);

        Intent vpnIntent = new Intent(getContext(), RelayVpnService.class);
        vpnIntent.setAction(RelayVpnService.ACTION_START_CLIENT);
        vpnIntent.putExtra(RelayVpnService.EXTRA_HOST_IP, host);
        vpnIntent.putExtra(RelayVpnService.EXTRA_HOST_PORT, port);

        if (Build.VERSION.SDK_INT >= 26) {
            getContext().startForegroundService(vpnIntent);
        } else {
            getContext().startService(vpnIntent);
        }

        JSObject res = new JSObject();
        res.put("active", true);
        res.put("hostIp", host);
        res.put("hostPort", port);
        call.resolve(res);
    }

    @PluginMethod
    public void stopClientAutoRouter(PluginCall call) {
        Intent vpnIntent = new Intent(getContext(), RelayVpnService.class);
        vpnIntent.setAction(RelayVpnService.ACTION_STOP_CLIENT);
        getContext().startService(vpnIntent);
        call.resolve();
    }

    @PluginMethod
    public void triggerCompanionFallback(PluginCall call) {
        startCompanionSearchFallback();
        JSObject res = new JSObject();
        res.put("success", true);
        call.resolve(res);
    }

    public void startCompanionSearchFallback() {
        Log.i("GlobalRelayPlugin", "Initiating automated companion relay fallback search");
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                android.net.DhcpInfo dhcp = wm.getDhcpInfo();
                if (dhcp != null && dhcp.gateway != 0) {
                    String detectedGw = android.text.format.Formatter.formatIpAddress(dhcp.gateway);
                    if (detectedGw != null && !detectedGw.equals("0.0.0.0") && !detectedGw.equals("127.0.0.1")) {
                        autoEngageClientRouter(detectedGw, RelayService.RELAY_PORT);
                    }
                }
            }
        } catch (Throwable ignored) {}

        if (!granted() || manager == null || channel == null) return;
        try {
            upstream = false;
            manager.setDnsSdResponseListeners(channel, (instance, type, device) -> {
                if (instance != null && instance.equals("GLOBAL-NETWORKS")) {
                    Log.i("GlobalRelayPlugin", "Discovered companion host: " + device.deviceName + " (" + device.deviceAddress + ")");
                    WifiP2pConfig config = new WifiP2pConfig();
                    config.deviceAddress = device.deviceAddress;
                    manager.connect(channel, config, action());
                }
            }, (domain, txt, device) -> {});

            manager.addServiceRequest(channel, android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest.newInstance(), action());
            manager.discoverServices(channel, action());
            manager.discoverPeers(channel, action());
        } catch (Throwable t) {
            Log.w("GlobalRelayPlugin", "Error starting Wi-Fi Direct companion fallback: " + t.getMessage());
        }
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        if (activeInstance == this) {
            activeInstance = null;
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        started = false;
        if (manager != null && channel != null) {
            manager.clearLocalServices(channel, null);
            manager.clearServiceRequests(channel, null);
            manager.removeGroup(channel, null);
        }
        Intent serviceIntent = new Intent(getContext(), RelayService.class);
        serviceIntent.setAction(RelayService.ACTION_STOP);
        getContext().startService(serviceIntent);

        Intent vpnIntent = new Intent(getContext(), RelayVpnService.class);
        vpnIntent.setAction(RelayVpnService.ACTION_STOP_CLIENT);
        getContext().startService(vpnIntent);

        relay = null;
        emit();
        call.resolve();
    }

    private void refreshGroup() {
        if (manager == null || channel == null) return;
        manager.requestConnectionInfo(channel, (info) -> {
            if (info == null || !info.groupFormed) {
                relay = null;
                emit();
                return;
            }
            manager.requestGroupInfo(channel, (group) -> {
                relay = new JSObject();
                relay.put("connected", true);
                relay.put("isGroupOwner", info.isGroupOwner);
                String ownerIp = info.groupOwnerAddress != null ? info.groupOwnerAddress.getHostAddress() : "";
                relay.put("groupOwnerAddress", ownerIp);
                relay.put("transportReady", RelayService.isRouterRunning() || info.groupFormed);
                relay.put("transportType", "wifi_direct_bridge");
                relay.put("peerCount", group != null ? group.getClientList().size() : 0);
                relay.put("txBytes", RelayService.getSentBytes());
                relay.put("rxBytes", RelayService.getReceivedBytes());
                relay.put("lastActiveAt", System.currentTimeMillis());
                if (group != null) {
                    relay.put("networkName", group.getNetworkName());
                    relay.put("passphrase", group.getPassphrase());
                }

                if (!info.isGroupOwner && ownerIp != null && !ownerIp.isEmpty()) {
                    autoEngageClientRouter(ownerIp, RelayService.RELAY_PORT);
                }

                emit();
            });
        });
    }

    private void autoEngageClientRouter(String hostIp, int port) {
        try {
            Intent vpnPrepare = VpnService.prepare(getContext());
            if (vpnPrepare != null && getActivity() != null) {
                getActivity().startActivityForResult(vpnPrepare, 101);
            }
            if (!RelayVpnService.isVpnRunning() && VpnService.prepare(getContext()) == null) {
                Intent vpnIntent = new Intent(getContext(), RelayVpnService.class);
                vpnIntent.setAction(RelayVpnService.ACTION_START_CLIENT);
                vpnIntent.putExtra(RelayVpnService.EXTRA_HOST_IP, hostIp);
                vpnIntent.putExtra(RelayVpnService.EXTRA_HOST_PORT, port);
                if (Build.VERSION.SDK_INT >= 26) {
                    getContext().startForegroundService(vpnIntent);
                } else {
                    getContext().startService(vpnIntent);
                }
            }
        } catch (Exception ignored) {}
    }

    @PluginMethod
    public void submitCaptivePortal(PluginCall call) {
        String ssid = call.getString("ssid");
        String portalUrl = call.getString("portalUrl");
        if (portalUrl == null || portalUrl.isEmpty()) {
            portalUrl = call.getString("loginUrl");
        }
        String voucherCode = call.getString("voucherCode");
        String phoneNumber = call.getString("phoneNumber");
        com.getcapacitor.JSObject fields = call.getObject("fields");

        if (portalUrl == null || portalUrl.isEmpty()) {
            call.reject("portalUrl or loginUrl is required");
            return;
        }

        final String finalPortalUrl = portalUrl;
        portalExecutor.execute(() -> {
            try {
                ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                Network targetNetwork = null;
                if (cm != null && Build.VERSION.SDK_INT >= 23) {
                    for (Network net : cm.getAllNetworks()) {
                        NetworkCapabilities caps = cm.getNetworkCapabilities(net);
                        if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                            targetNetwork = net;
                            break;
                        }
                    }
                }

                URL url = new URL(finalPortalUrl);
                HttpURLConnection conn;
                if (targetNetwork != null && Build.VERSION.SDK_INT >= 23) {
                    conn = (HttpURLConnection) targetNetwork.openConnection(url);
                } else {
                    conn = (HttpURLConnection) url.openConnection();
                }

                conn.setRequestMethod("POST");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setDoOutput(true);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");

                StringBuilder postData = new StringBuilder();
                if (fields != null) {
                    java.util.Iterator<String> keys = fields.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        String val = fields.getString(key, "");
                        if (postData.length() > 0) postData.append("&");
                        postData.append(URLEncoder.encode(key, "UTF-8")).append("=").append(URLEncoder.encode(val, "UTF-8"));
                    }
                }
                if (voucherCode != null && !voucherCode.isEmpty() && (fields == null || (!fields.has("voucher") && !fields.has("code") && !fields.has("pin")))) {
                    if (postData.length() > 0) postData.append("&");
                    postData.append("voucher=").append(URLEncoder.encode(voucherCode, "UTF-8"));
                    postData.append("&code=").append(URLEncoder.encode(voucherCode, "UTF-8"));
                    postData.append("&pin=").append(URLEncoder.encode(voucherCode, "UTF-8"));
                }
                if (phoneNumber != null && !phoneNumber.isEmpty() && (fields == null || !fields.has("phone"))) {
                    if (postData.length() > 0) postData.append("&");
                    postData.append("phone=").append(URLEncoder.encode(phoneNumber, "UTF-8"));
                }

                byte[] out = postData.toString().getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(out.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(out);
                }

                int code = conn.getResponseCode();
                boolean success = code >= 200 && code < 400;

                JSObject res = new JSObject();
                res.put("validated", success);
                res.put("success", success);
                res.put("statusCode", code);
                res.put("message", "Submitted with response code " + code);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Captive portal post failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        String downloadUrl = call.getString("url");
        if (downloadUrl == null || downloadUrl.isEmpty()) {
            downloadUrl = "https://github.com/CHRISOSTIVEJASON/signal-saver-roaming-pass/releases/download/latest-apk/app-debug.apk";
        }
        final String targetUrl = downloadUrl;
        final android.app.Activity activity = getActivity();
        if (activity == null || activity.isFinishing()) {
            call.reject("App activity not available");
            return;
        }

        portalExecutor.execute(() -> {
            try {
                URL url = new URL(targetUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestProperty("User-Agent", "Signal-Saver-Roaming-Pass-Android");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(true);

                int size = conn.getContentLength();
                File dir = activity.getExternalCacheDir();
                if (dir == null) dir = activity.getCacheDir();
                File apk = new File(dir, "signal-roaming-update.apk");

                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[8192];
                    long total = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        total += n;
                        out.write(buf, 0, n);
                        if (size > 0) {
                            int pct = (int) Math.min(100, total * 100 / size);
                            JSObject progress = new JSObject();
                            progress.put("progress", pct);
                            progress.put("status", "Downloading update (" + pct + "%)");
                            notifyListeners("updateProgress", progress);
                        }
                    }
                    out.getFD().sync();
                }

                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName()));
                            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            activity.startActivity(settings);
                        }

                        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apk);
                        Intent install = new Intent(Intent.ACTION_VIEW);
                        install.setDataAndType(uri, "application/vnd.android.package-archive");
                        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(install);

                        JSObject res = new JSObject();
                        res.put("success", true);
                        res.put("message", "Installer launched");
                        call.resolve(res);
                    } catch (Exception e) {
                        call.reject("Failed to launch installer: " + e.getMessage());
                    }
                });
            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void syncWatcherConfig(PluginCall call) {
        try {
            JSArray ssidsArray = call.getArray("poolSsids");
            JSArray bssidsArray = call.getArray("poolBssids");
            boolean hasActivePass = call.getBoolean("hasActivePass", false);
            boolean soundAlerts = call.getBoolean("soundAlerts", call.getBoolean("beepAlertsEnabled", true));

            List<String> ssids = new ArrayList<>();
            if (ssidsArray != null) {
                for (int i = 0; i < ssidsArray.length(); i++) {
                    try {
                        String s = ssidsArray.getString(i);
                        if (s != null) ssids.add(s);
                    } catch (Exception ignored) {}
                }
            }

            List<String> bssids = new ArrayList<>();
            if (bssidsArray != null) {
                for (int i = 0; i < bssidsArray.length(); i++) {
                    try {
                        String b = bssidsArray.getString(i);
                        if (b != null) bssids.add(b);
                    } catch (Exception ignored) {}
                }
            }

            JSObject passObj = call.getObject("poolPasswords");
            Map<String, String> passwords = new HashMap<>();
            if (passObj != null) {
                Iterator<String> keys = passObj.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    try {
                        String v = passObj.getString(k);
                        if (v != null) passwords.put(k, v);
                    } catch (Exception ignored) {}
                }
            }

            NetworkWatcher.getInstance(getContext()).syncConfig(ssids, bssids, hasActivePass, soundAlerts, passwords);
            JSObject res = new JSObject();
            res.put("success", true);
            call.resolve(res);
        } catch (Throwable t) {
            call.reject("Failed to sync watcher config: " + t.getMessage());
        }
    }

    @PluginMethod
    public void clearAuthFailed(PluginCall call) {
        try {
            NetworkWatcher.getInstance(getContext()).clearLastAuthFailedSsid();
        } catch (Throwable ignored) {}
        com.getcapacitor.JSObject res = new com.getcapacitor.JSObject();
        res.put("success", true);
        call.resolve(res);
    }

    @PluginMethod
    public void playBeepTone(PluginCall call) {
        try {
            NetworkWatcher.playUniqueThreeBeepTone();
            JSObject res = new JSObject();
            res.put("success", true);
            call.resolve(res);
        } catch (Throwable t) {
            call.reject("Failed to play tone: " + t.getMessage());
        }
    }

    @PluginMethod
    public void saveDevicePhone(PluginCall call) {
        String phone = call.getString("phone");
        if (phone != null && !phone.isEmpty()) {
            try {
                android.content.SharedPreferences prefs = getContext().getSharedPreferences("gn_identity_prefs", Context.MODE_PRIVATE);
                prefs.edit().putString("saved_phone", phone).apply();
            } catch (Exception ignored) {}
        }
        JSObject res = new JSObject();
        res.put("success", true);
        call.resolve(res);
    }

    @PluginMethod
    public void getDevicePhone(PluginCall call) {
        JSObject res = new JSObject();
        try {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("gn_identity_prefs", Context.MODE_PRIVATE);
            String phone = prefs.getString("saved_phone", "");
            res.put("phone", phone != null ? phone : "");
        } catch (Exception ignored) {
            res.put("phone", "");
        }
        call.resolve(res);
    }

    @PluginMethod
    public void saveDeviceId(PluginCall call) {
        String deviceId = call.getString("deviceId");
        if (deviceId != null && !deviceId.isEmpty()) {
            try {
                android.content.SharedPreferences prefs = getContext().getSharedPreferences("gn_identity_prefs", Context.MODE_PRIVATE);
                prefs.edit().putString("saved_device_id", deviceId).apply();
            } catch (Exception ignored) {}
        }
        JSObject res = new JSObject();
        res.put("success", true);
        call.resolve(res);
    }

    @PluginMethod
    public void getDeviceId(PluginCall call) {
        JSObject res = new JSObject();
        try {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences("gn_identity_prefs", Context.MODE_PRIVATE);
            String deviceId = prefs.getString("saved_device_id", "");
            res.put("deviceId", deviceId != null ? deviceId : "");
        } catch (Exception ignored) {
            res.put("deviceId", "");
        }
        call.resolve(res);
    }
}