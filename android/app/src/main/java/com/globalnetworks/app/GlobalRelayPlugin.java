package com.globalnetworks.app;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
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
import android.provider.Settings;

import com.getcapacitor.JSObject;
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

@CapacitorPlugin(name="GlobalRelay", permissions={
    @Permission(alias="location", strings={Manifest.permission.ACCESS_FINE_LOCATION}),
    @Permission(alias="nearby", strings={"android.permission.NEARBY_WIFI_DEVICES"})
})
public class GlobalRelayPlugin extends Plugin {
    private WifiP2pManager manager;
    private WifiP2pManager.Channel channel;
    private WifiAwareSession awareSession;
    private PublishDiscoverySession publication;
    private BroadcastReceiver receiver;
    private boolean started = false;
    private boolean upstream = false;
    private JSObject relay;
    private final String networkName = "DIRECT-GLOBAL-NETWORKS";
    private final ExecutorService portalExecutor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
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

    private boolean granted() {
        return getPermissionState("location") == PermissionState.GRANTED &&
               (Build.VERSION.SDK_INT < 33 || getPermissionState("nearby") == PermissionState.GRANTED);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (granted()) {
            accessResult(call);
            return;
        }
        requestPermissionForAliases(
            Build.VERSION.SDK_INT >= 33 ? new String[]{"location", "nearby"} : new String[]{"location"},
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
        result.put("granted", granted());
        if (granted()) {
            WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wifi != null) {
                android.net.wifi.WifiInfo info = wifi.getConnectionInfo();
                String ssid = info.getSSID();
                if (ssid != null && !ssid.equals("<unknown ssid>")) {
                    result.put("ssid", ssid.replace("\"", ""));
                    result.put("bssid", info.getBSSID());
                }
            }
        }
        if (relay != null) result.put("relay", relay);
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

        Intent serviceIntent = new Intent(getContext(), RelayService.class);
        serviceIntent.setAction(RelayService.ACTION_START_HOST);
        if (Build.VERSION.SDK_INT >= 26) {
            getContext().startForegroundService(serviceIntent);
        } else {
            getContext().startService(serviceIntent);
        }

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
                relay.put("groupOwnerAddress", info.groupOwnerAddress != null ? info.groupOwnerAddress.getHostAddress() : "");
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
                emit();
            });
        });
    }

    @PluginMethod
    public void submitCaptivePortal(PluginCall call) {
        String ssid = call.getString("ssid");
        String portalUrl = call.getString("portalUrl");
        String voucherCode = call.getString("voucherCode");
        String phoneNumber = call.getString("phoneNumber");

        if (portalUrl == null || portalUrl.isEmpty()) {
            call.reject("portalUrl is required");
            return;
        }

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

                URL url = new URL(portalUrl);
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
                if (voucherCode != null && !voucherCode.isEmpty()) {
                    postData.append("voucher=").append(URLEncoder.encode(voucherCode, "UTF-8"));
                    postData.append("&code=").append(URLEncoder.encode(voucherCode, "UTF-8"));
                    postData.append("&pin=").append(URLEncoder.encode(voucherCode, "UTF-8"));
                }
                if (phoneNumber != null && !phoneNumber.isEmpty()) {
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
                res.put("success", success);
                res.put("statusCode", code);
                res.put("message", "Submitted with response code " + code);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Captive portal post failed: " + e.getMessage());
            }
        });
    }
}
