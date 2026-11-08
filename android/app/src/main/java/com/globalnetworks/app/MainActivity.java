package com.globalnetworks.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final int PERM_REQUEST_CODE = 100;
    private static final int VPN_REQUEST_CODE = 101;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GlobalRelayPlugin.class);
        super.onCreate(savedInstanceState);

        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            webView.setBackgroundColor(Color.parseColor("#0c0e14"));

            WebSettings settings = webView.getSettings();
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setCacheMode(WebSettings.LOAD_DEFAULT);

            getBridge().setWebViewClient(new AppBridgeWebViewClient(getBridge()));
        }

        checkAndRequestMandatoryPermissions();
        AppUpdateChecker.checkForUpdates(this);
    }

    private void checkAndRequestMandatoryPermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            List<String> needed = new ArrayList<>();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.ACCESS_COARSE_LOCATION);
            }
            if (Build.VERSION.SDK_INT >= 33) {
                if (checkSelfPermission("android.permission.NEARBY_WIFI_DEVICES") != PackageManager.PERMISSION_GRANTED) {
                    needed.add("android.permission.NEARBY_WIFI_DEVICES");
                }
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    needed.add(Manifest.permission.POST_NOTIFICATIONS);
                }
            }
            if (!needed.isEmpty()) {
                requestPermissions(needed.toArray(new String[0]), PERM_REQUEST_CODE);
            }
        }

        try {
            Intent vpnIntent = VpnService.prepare(this);
            if (vpnIntent != null) {
                startActivityForResult(vpnIntent, VPN_REQUEST_CODE);
            }
        } catch (Exception ignored) {}
    }

    private static class AppBridgeWebViewClient extends BridgeWebViewClient {
        AppBridgeWebViewClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                String offlineHtml = "<!doctype html><html><head><meta charset='utf-8'>"
                        + "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no'>"
                        + "<title>Global Networks</title><style>"
                        + "body{margin:0;padding:24px;background:#0c0e14;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;box-sizing:border-box;text-align:center;}"
                        + ".card{background:rgba(22,27,34,0.95);border:1px solid #30363d;border-radius:24px;padding:32px 24px;max-width:380px;width:100%;box-shadow:0 12px 36px rgba(0,0,0,0.5);}"
                        + ".title{font-size:24px;font-weight:800;letter-spacing:0.15em;color:#00ff9d;margin:0 0 6px;}"
                        + ".sub{font-size:11px;letter-spacing:0.25em;color:#8b949e;text-transform:uppercase;margin:0 0 24px;}"
                        + ".alert{background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.4);color:#e3b341;border-radius:12px;padding:12px;font-size:13px;font-weight:600;margin-bottom:20px;display:flex;align-items:center;justify-content:center;gap:8px;}"
                        + ".desc{font-size:13px;line-height:1.6;color:#8b949e;margin:0 0 24px;}"
                        + ".btn{display:block;width:100%;height:48px;line-height:48px;background:#00ff9d;color:#04090c;font-weight:700;font-size:15px;border-radius:12px;text-decoration:none;border:none;cursor:pointer;}"
                        + ".retry-note{font-size:11px;color:#6e7681;margin-top:16px;}"
                        + "</style></head><body><div class='card'>"
                        + "<div class='title'>GLOBAL NETWORKS</div>"
                        + "<div class='sub'>Internet that follows you</div>"
                        + "<div class='alert'>⚠️ No Network Connection</div>"
                        + "<p class='desc'>Internet is currently unavailable or connecting to a hotspot. Stamped networks and active passes saved on this device remain safe. Reconnecting automatically as soon as connection is detected...</p>"
                        + "<button class='btn' onclick='location.reload()'>⚡ Retry Connection</button>"
                        + "<div class='retry-note' id='status'>Auto-reconnecting every 3 seconds…</div>"
                        + "</div><script>"
                        + "setInterval(function(){ if(navigator.onLine){ location.reload(); } }, 3000);"
                        + "</script></body></html>";

                view.loadDataWithBaseURL("https://signal-saver-roaming-pass.lovable.app", offlineHtml, "text/html", "UTF-8", null);
                return;
            }
            super.onReceivedError(view, request, error);
        }
    }
}
