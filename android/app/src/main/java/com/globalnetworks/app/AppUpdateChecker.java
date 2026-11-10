package com.globalnetworks.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Checks for mandatory updates on app launch via Supabase gn_settings and prompts user to install.
 */
public final class AppUpdateChecker {
    private static final String TAG = "AppUpdateChecker";
    private static final String SETTINGS_API = "https://ddzountfjjlfngshwrce.supabase.co/rest/v1/gn_settings?id=eq.global&select=apk_url,latest_version,update_required";
    private static final String SUPABASE_KEY = "sb_publishable_8IdamU64XULEckvATKINhQ_dmsq67Na";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static volatile boolean checkInFlight = false;

    private AppUpdateChecker() {}

    public static void checkForUpdates(final Activity activity) {
        if (activity == null || activity.isFinishing()) return;
        synchronized (AppUpdateChecker.class) {
            if (checkInFlight) return;
            checkInFlight = true;
        }

        EXECUTOR.execute(() -> {
            try {
                URL url = new URL(SETTINGS_API);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("apikey", SUPABASE_KEY);
                conn.setRequestProperty("Authorization", "Bearer " + SUPABASE_KEY);
                conn.setRequestProperty("User-Agent", "Signal-Saver-Roaming-Pass-Android");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);

                if (conn.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    Log.w(TAG, "Update check returned HTTP " + conn.getResponseCode());
                    return;
                }

                StringBuilder text = new StringBuilder();
                try (InputStream in = conn.getInputStream()) {
                    byte[] buf = new byte[2048];
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        text.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                    }
                }

                JSONArray arr = new JSONArray(text.toString());
                if (arr.length() == 0) return;
                JSONObject settings = arr.getJSONObject(0);

                String latestVersion = settings.optString("latest_version", "").trim();
                String apkUrl = settings.optString("apk_url", "").trim();
                boolean updateRequired = settings.optBoolean("update_required", false);

                PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
                String currentVersion = info.versionName != null ? info.versionName.trim() : "1.0.0";

                if (apkUrl.isEmpty()) {
                    apkUrl = "https://github.com/CHRISOSTIVEJASON/signal-saver-roaming-pass/releases/download/latest-apk/app-debug.apk";
                }

                boolean isNewer = isNewerVersion(latestVersion, currentVersion);
                if (isNewer || (updateRequired && !latestVersion.isEmpty() && !latestVersion.equals(currentVersion))) {
                    final String targetUrl = apkUrl;
                    MAIN.post(() -> showMandatoryUpdateDialog(activity, targetUrl));
                }
            } catch (Exception e) {
                Log.w(TAG, "Update check failed", e);
            } finally {
                synchronized (AppUpdateChecker.class) {
                    checkInFlight = false;
                }
            }
        });
    }

    private static boolean isNewerVersion(String remote, String local) {
        if (remote == null || remote.isEmpty()) return false;
        if (local == null || local.isEmpty()) return true;
        try {
            String[] rParts = remote.replaceAll("[^0-9.]", "").split("\\.");
            String[] lParts = local.replaceAll("[^0-9.]", "").split("\\.");
            int length = Math.max(rParts.length, lParts.length);
            for (int i = 0; i < length; i++) {
                int r = i < rParts.length && !rParts[i].isEmpty() ? Integer.parseInt(rParts[i]) : 0;
                int l = i < lParts.length && !lParts[i].isEmpty() ? Integer.parseInt(lParts[i]) : 0;
                if (r > l) return true;
                if (r < l) return false;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private static void showMandatoryUpdateDialog(final Activity activity, final String downloadUrl) {
        if (activity == null || activity.isFinishing()) return;

        AlertDialog.Builder builder = new AlertDialog.Builder(activity);
        builder.setTitle("Update Required");
        builder.setMessage("A new version of Signal Saver / Global Networks is available. You must update to continue using the app.");
        builder.setCancelable(false);
        builder.setPositiveButton("Update Now", (dialog, which) -> downloadAndInstall(activity, downloadUrl));
        AlertDialog dialog = builder.create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.show();
    }

    private static void downloadAndInstall(final Activity activity, final String downloadUrl) {
        ProgressDialog progress = new ProgressDialog(activity);
        progress.setTitle("Downloading Update");
        progress.setMessage("Downloading the latest version, please wait...");
        progress.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progress.setMax(100);
        progress.setIndeterminate(false);
        progress.setCancelable(false);
        progress.setCanceledOnTouchOutside(false);
        progress.show();

        EXECUTOR.execute(() -> {
            try {
                URL url = new URL(downloadUrl);
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
                            MAIN.post(() -> progress.setProgress(pct));
                        }
                    }
                    out.getFD().sync();
                }

                MAIN.post(() -> {
                    dismiss(progress);
                    installApk(activity, apk);
                });
            } catch (Exception e) {
                Log.e(TAG, "Download failed", e);
                MAIN.post(() -> {
                    dismiss(progress);
                    if (!activity.isFinishing()) {
                        new AlertDialog.Builder(activity)
                                .setTitle("Update Failed")
                                .setMessage("Failed to download update: " + e.getMessage() + "\n\nPlease check your internet connection.")
                                .setCancelable(false)
                                .setPositiveButton("Retry", (d, w) -> downloadAndInstall(activity, downloadUrl))
                                .show();
                    }
                });
            }
        });
    }

    private static void dismiss(ProgressDialog dialog) {
        try {
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
        } catch (Exception ignored) {}
    }

    private static void installApk(Context context, File apk) {
        try {
            if (Build.VERSION.SDK_INT >= 26 && !context.getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(settings);
                return;
            }

            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(install);
        } catch (Exception e) {
            Log.e(TAG, "Failed to launch installer", e);
        }
    }
}
