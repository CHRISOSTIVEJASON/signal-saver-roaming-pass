package com.globalnetworks.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "BootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        Log.i(TAG, "Boot event received: " + action);
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(action) ||
            Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {

            try {
                Intent serviceIntent = new Intent(context, RelayService.class);
                serviceIntent.setAction(RelayService.ACTION_START_HOST);
                if (Build.VERSION.SDK_INT >= 26) {
                    context.startForegroundService(serviceIntent);
                } else {
                    context.startService(serviceIntent);
                }
                Log.i(TAG, "RelayService successfully dispatched on boot");
            } catch (Exception e) {
                Log.e(TAG, "Failed to start RelayService on boot", e);
            }
        }
    }
}
