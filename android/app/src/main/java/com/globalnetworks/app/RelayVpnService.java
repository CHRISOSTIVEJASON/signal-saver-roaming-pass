package com.globalnetworks.app;

import android.content.Intent;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;

public class RelayVpnService extends VpnService {
    private ParcelFileDescriptor vpnInterface;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (vpnInterface != null) return START_STICKY;

        try {
            Builder builder = new Builder();
            builder.setSession("Global Networks Client Tunnel");
            builder.addAddress("10.8.0.2", 24);
            builder.addRoute("0.0.0.0", 0);
            builder.addDnsServer("8.8.8.8");
            builder.addDnsServer("1.1.1.1");
            builder.setMtu(1500);

            vpnInterface = builder.establish();
        } catch (Exception ignored) {}

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (vpnInterface != null) {
            try { vpnInterface.close(); } catch (Exception ignored) {}
            vpnInterface = null;
        }
        super.onDestroy();
    }
}
