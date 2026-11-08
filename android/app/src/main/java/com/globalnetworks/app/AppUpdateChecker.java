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
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.TimeZone;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Checks for mandatory updates on app launch and prompts the user to download and install.
 */
public final class AppUpdateChecker {
    private static final String TAG = "AppUpdateChecker";
    private static final String RELEASE_API = "https://api.github.com/repos/CHRISOSTIVEJASON/signal-saver-roaming-pass/releases/tags/latest-apk";
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
                URL url = new URL(RELEASE_API);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/vnd.github+json");
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

                JSONObject release = new JSONObject(text.toString());
                String publishedAt = release.optString("published_at", "");
                long releaseTime = parseReleaseTime(publishedAt);

                PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
                long installedTime = info.lastUpdateTime;

                String apkUrl = findApkUrl(release);
                if (apkUrl == null) {
                    apkUrl = "https://github.com/CHRISOSTIVEJASON/signal-saver-roaming-pass/releases/download/latest-apk/app-debug.apk";
                }

                // If remote release is newer than local build timestamp (by at least 2 minutes)
                if (releaseTime > (installedTime + 120000L)) {
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

    private static long parseReleaseTime(String value) {
        try {
            SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
            fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
            return fmt.parse(value).getTime();
        } catch (Exception ignored) {
            return 0L;
        }
    }

    private static String findApkUrl(JSONObject release) {
        try {
            if (release.has("assets")) {
                JSONArray assets = release.getJSONArray("assets");
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject asset = assets.getJSONObject(i);
                    String name = asset.optString("name", "");
                    if ("app-debug.apk".equals(name) || name.endsWith(".apk")) {
                        return asset.optString("browser_download_url", null);
                    }
                }
            }
        } catch (Exception ignored) {}
        return null;
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
                                .setMessage("Failed to download update: " + e.getMessage() + "

Please check your internet connection.")
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
