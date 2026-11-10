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

            webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
                try {
                    android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
                    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception e) {
                    android.util.Log.e("MainActivity", "Download listener error", e);
                }
            });

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
                        + ".title{font-size:22px;font-weight:800;letter-spacing:0.15em;color:#00ff9d;margin:0 0 6px;}"
                        + ".sub{font-size:11px;letter-spacing:0.25em;color:#8b949e;text-transform:uppercase;margin:0 0 20px;}"
                        + ".alert{background:rgba(210,153,34,0.15);border:1px solid rgba(210,153,34,0.4);color:#e3b341;border-radius:12px;padding:10px 14px;font-size:12px;font-weight:600;margin-bottom:18px;display:flex;align-items:center;justify-content:center;gap:6px;}"
                        + ".step-card{background:rgba(0,255,157,0.06);border:1px solid rgba(0,255,157,0.25);border-radius:14px;padding:14px;margin-bottom:20px;text-align:left;font-size:12px;line-height:1.5;color:#c9d1d9;}"
                        + ".step-row{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px;}"
                        + ".step-num{background:#00ff9d;color:#04090c;font-weight:bold;border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;}"
                        + ".btn{display:block;width:100%;height:48px;line-height:48px;background:#00ff9d;color:#04090c;font-weight:700;font-size:14px;border-radius:12px;text-decoration:none;border:none;cursor:pointer;}"
                        + ".retry-note{font-size:11px;color:#8b949e;margin-top:14px;}"
                        + "</style></head><body><div class='card'>"
                        + "<div class='title'>GLOBAL NETWORKS</div>"
                        + "<div class='sub'>Internet that follows you</div>"
                        + "<div class='alert'>📶 Wi-Fi Hotspot Connected (Pass Required)</div>"
                        + "<div class='step-card'>"
                        + "<div class='step-row'><span class='step-num'>1</span><span><strong>Turn ON Mobile Data</strong> (swipe down from top). Zero data bundles required — Safaricom sends M-Pesa PIN prompt for free.</span></div>"
                        + "<div class='step-row' style='margin-bottom:0;'><span class='step-num'>2</span><span>Tap <strong>Open Roaming Pass Portal</strong> below to enter PIN & unlock high-speed Wi-Fi.</span></div>"
                        + "</div>"
                        + "<button class='btn' onclick='location.reload()'>⚡ Open Roaming Pass Portal</button>"
                        + "<div class='retry-note' id='status'>Auto-detecting connection every 3s…</div>"
                        + "</div><script>"
                        + "window.addEventListener('online', function(){ location.reload(); });"
                        + "setInterval(function(){ if(navigator.onLine){ location.reload(); } }, 3000);"
                        + "</script></body></html>";

                view.loadDataWithBaseURL("https://signal-saver-roaming-pass.lovable.app", offlineHtml, "text/html", "UTF-8", null);
                return;
            }
            super.onReceivedError(view, request, error);
        }
    }
}
