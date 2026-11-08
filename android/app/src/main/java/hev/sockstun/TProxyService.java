package hev.sockstun;

import android.util.Log;

public final class TProxyService {
    private static volatile boolean loaded = false;

    static {
        try {
            System.loadLibrary("hev-socks5-tunnel");
            loaded = true;
        } catch (Throwable t) {
            Log.e("TProxyService", "Failed to load native hev-socks5-tunnel library", t);
        }
    }

    private TProxyService() {}

    public static boolean isLoaded() {
        return loaded;
    }

    public static native void TProxyStartService(String configPath, int fd);

    public static native void TProxyStopService();

    public static native long[] TProxyGetStats();
}
