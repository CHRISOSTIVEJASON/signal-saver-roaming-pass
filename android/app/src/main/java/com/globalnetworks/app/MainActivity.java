package com.globalnetworks.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final int PERM_REQUEST_CODE = 100;
    private static final int VPN_REQUEST_CODE = 101;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GlobalRelayPlugin.class);
        super.onCreate(savedInstanceState);
        checkAndRequestMandatoryPermissions();
    }

    @Override
    public void onStart() {
        super.onStart();
        checkAndRequestMandatoryPermissions();
    }

    private void checkAndRequestMandatoryPermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            List<String> needed = new ArrayList<>();
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.ACCESS_FINE_LOCATION);
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
}
