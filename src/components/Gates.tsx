import { useState, useEffect, type ReactNode } from "react";
import { BatteryCharging, Download, FlaskConical, RefreshCw, Settings, ShieldAlert, Share2, Wifi, X, Laptop } from "lucide-react";
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { GlobalRelay } from "@/lib/native-relay";
import { Button } from "./ui/button";
import { APP_VERSION } from "@/lib/rules";
import { KEYS, defaultConfig, defaultDevice, useStored, useAppVersion, setRunningAppVersion, type Device, type Network, type PayConfig, type Perm } from "@/lib/store";

export const useDevice = () => useStored<Device>(KEYS.device, defaultDevice);
export const useConfig = () => {
  const [c, set] = useStored<PayConfig>(KEYS.config, defaultConfig);
  return [{ ...defaultConfig, ...c }, set] as const;
};

const PERMS: { key: keyof Device["perms"]; title: string; why: string; icon: ReactNode }[] = [
  { key: "wifi", title: "Location & Nearby Wi-Fi Devices", why: "Mandatory location and nearby devices permission to scan, detect, and automatically connect to stamped pool Wi-Fi signals.", icon: <Wifi className="h-5 w-5" /> },
  { key: "background", title: "Unrestricted Battery & Background Running", why: "Prevents Android from putting the network watcher to sleep when the screen is locked.", icon: <BatteryCharging className="h-5 w-5" /> },
  { key: "autostart", title: "Auto-Start & Boot Persistence", why: "Ensures the network watcher and background roaming service automatically resume when your phone reboots.", icon: <RefreshCw className="h-5 w-5" /> },
  { key: "relay", title: "Status Notification & Foreground Service", why: "Required for the persistent foreground service to keep network sharing and alerts active.", icon: <Share2 className="h-5 w-5" /> },
];

function openApk(url: string) {
  if (!url) {
    toast.error("The download link isn't ready yet. Please check back soon.");
    return;
  }
  toast.success("Opening APK download...");
  try {
    window.location.href = url;
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

export function DownloadGate() {
  const [cfg] = useConfig();
  const [, setDevice] = useDevice();
  const isMobile = typeof navigator !== "undefined" && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  const continueOnLaptop = () => {
    setDevice((prev) => ({
      ...prev,
      appMode: true,
      onboarded: true,
      perms: { background: "granted", wifi: "granted", relay: "granted", autostart: "granted" },
    }));
  };

  return (
    <div className="space-y-5 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
        <Download className="h-8 w-8 text-primary" />
      </div>
      <div>
        <h2 className="text-xl font-bold">{isMobile ? "Download Global Networks Android App" : "Global Networks Web Portal"}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {isMobile
            ? "On a mobile phone, please download and install the Android app to connect to the pool and share Wi-Fi."
            : "Buy a pass with M-Pesa or restore your active pass right here on your laptop."}
        </p>
      </div>

      {!isMobile && (
        <Button onClick={continueOnLaptop}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-[0_0_24px_-6px_var(--primary)] hover:brightness-110">
          Continue to Laptop Web Portal
        </Button>
      )}

      <Button onClick={() => openApk(cfg.apkUrl)}
        variant={!isMobile ? "outline" : "default"}
        className={!isMobile ? "flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-border text-sm font-semibold hover:bg-secondary" : "flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-[0_0_24px_-6px_var(--primary)] hover:brightness-110"}>
        <Download className="h-5 w-5" /> Download Android APK
      </Button>

      {isMobile ? (
        <ul className="space-y-1 text-left text-xs text-muted-foreground">
          <li>1. Tap download and open the file.</li>
          <li>2. If asked, allow installing from this source.</li>
          <li>3. Open Global Networks and pick a pass.</li>
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">
          Using a laptop? You can purchase passes or access administrative settings directly from your browser.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">Version {cfg.latestVersion || APP_VERSION}</p>
    </div>
  );
}

export function UpdateGate() {
  const [cfg] = useConfig();
  const [runningVer] = useAppVersion();
  const [status, setStatus] = useState<string | null>(null);
  const targetUrl = cfg.apkUrl?.trim() || "https://github.com/CHRISOSTIVEJASON/signal-saver-roaming-pass/releases/download/latest-apk/app-debug.apk";
  const [progress, setProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<boolean>(false);

  useEffect(() => {
    let handle: any = null;
    if (Capacitor.isNativePlatform()) {
      GlobalRelay.addListener("updateProgress", (data: { progress: number; status: string }) => {
        if (typeof data.progress === "number") setProgress(data.progress);
        if (data.status) setStatus(data.status);
      }).then((h) => { handle = h; }).catch(() => {});
    }
    return () => {
      if (handle?.remove) handle.remove();
    };
  }, []);

  const handleUpdate = async () => {
    setError(null);
    setStatus("Updating… starting download");
    setProgress(10);
    setCompleted(false);

    if (Capacitor.isNativePlatform()) {
      try {
        const res = await GlobalRelay.installUpdate({ url: targetUrl });
        if (res?.success) {
          setProgress(100);
          setStatus("Update downloaded! Launching Android package installer…");
          setCompleted(true);
          setRunningAppVersion(cfg.latestVersion);
          return;
        }
      } catch (err: any) {
        console.warn("Native installUpdate unavailable or failed:", err);
        const rawMsg = String(err?.message || err || "");
        const isOlderBuild = rawMsg.toLowerCase().includes("not implemented");
        setError(
          isOlderBuild
            ? "Automatic in-app update is not supported by your current build. Tap 'Download APK Directly' below, then tap the downloaded file in your notification bar to complete the update."
            : "In-app update could not complete automatically. Tap 'Download APK Directly' below to update manually."
        );
        setStatus(null);
        setProgress(0);
        return;
      }
    } else {
      // Browser / laptop: download update package directly in-place without redirecting
      try {
        setStatus("Downloading update package…");
        setProgress(40);
        const a = document.createElement("a");
        a.href = targetUrl;
        a.download = "GlobalNetworks-latest.apk";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setProgress(100);
        setStatus("Update downloaded! Applying version v" + cfg.latestVersion + "…");
        setCompleted(true);
        setRunningAppVersion(cfg.latestVersion);
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      } catch (err: any) {
        setError("Unable to download update package: " + (err?.message || "Unknown error"));
        setStatus(null);
      }
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/90 p-4 backdrop-blur">
      <div role="alertdialog" aria-label="Update required" className="w-full max-w-sm space-y-4 rounded-2xl border border-accent/40 bg-card p-6 text-center shadow-[var(--shadow-ambient)]">
        <RefreshCw className={`mx-auto h-10 w-10 text-accent ${status && !completed ? "animate-spin" : ""}`} />
        <h2 className="text-lg font-bold">
          {completed ? "Update Ready!" : status ? "Updating Global Networks…" : "A new version is available"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {completed
            ? "Package downloaded. Please tap 'Install' on your device to complete the update."
            : status
            ? "Downloading the latest update package directly inside the app. Please wait…"
            : `Version ${cfg.latestVersion} is required to continue. This app is running v${runningVer}.`}
        </p>

        {status && (
          <div className="space-y-2">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full bg-accent transition-all duration-300"
                style={{ width: `${Math.max(8, progress)}%` }}
              />
            </div>
            <p className="text-xs text-accent font-medium">{status}</p>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive text-left space-y-1.5 shadow-sm">
            <p className="font-semibold flex items-center gap-1.5 text-destructive">
              <span>⚠️</span> In-App Update Could Not Finish
            </p>
            <p className="text-muted-foreground leading-relaxed text-[11px]">{error}</p>
          </div>
        )}

        <div className="space-y-2">
          <Button
            onClick={handleUpdate}
            disabled={Boolean(status && !completed && !error)}
            className="h-12 w-full rounded-xl bg-accent font-semibold text-accent-foreground hover:brightness-110 disabled:opacity-70"
          >
            {completed ? "Re-launch Installer" : status ? (progress >= 100 ? "Installing…" : `Updating… ${progress}%`) : error ? "Retry In-App Update" : "Update Now"}
          </Button>
          {Boolean(error) && (
            <Button
              type="button"
              variant="outline"
              onClick={() => openApk(targetUrl)}
              className="h-11 w-full rounded-xl border border-border text-xs font-medium hover:bg-secondary flex items-center justify-center gap-1.5"
            >
              <Download className="h-4 w-4" /> Download APK Directly
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Onboarding() {
  const [device, setDevice] = useDevice();
  const [loadingKey, setLoadingKey] = useState<string | null>(null);

  const allApproved = PERMS.every((p) => device.perms[p.key] === "granted");

  const grant = async (key: keyof Device["perms"]) => {
    setLoadingKey(key as string);
    try {
      if (Capacitor.isNativePlatform()) {
        if (key === "wifi" || key === "relay") {
          const res = await GlobalRelay.requestAccess();
          if (res.granted) {
            setDevice((prev) => ({ ...prev, perms: { ...prev.perms, [key]: "granted" } }));
            toast.success("Permission granted!");
          } else {
            toast.error("Please allow the permission in the prompt to continue.");
          }
        } else if (key === "background") {
          await GlobalRelay.requestBatteryExemption();
          setDevice((prev) => ({ ...prev, perms: { ...prev.perms, background: "granted" } }));
          toast.success("Battery optimization set to Unrestricted!");
        } else if (key === "autostart") {
          if (typeof GlobalRelay.openAutostartSettings === "function") {
            await GlobalRelay.openAutostartSettings();
          } else {
            await GlobalRelay.openSettings();
          }
          setDevice((prev) => ({ ...prev, perms: { ...prev.perms, autostart: "granted" } }));
          toast.success("Auto-start permission accepted!");
        }
      } else {
        setDevice((prev) => ({ ...prev, perms: { ...prev.perms, [key]: "granted" } }));
        toast.success("Permission accepted!");
      }
    } catch (_) {
      setDevice((prev) => ({ ...prev, perms: { ...prev.perms, [key]: "granted" } }));
    } finally {
      setLoadingKey(null);
    }
  };

  const grantAll = async () => {
    setLoadingKey("all");
    try {
      if (Capacitor.isNativePlatform()) {
        await GlobalRelay.requestAccess();
        await GlobalRelay.requestBatteryExemption();
        if (typeof GlobalRelay.openAutostartSettings === "function") {
          try { await GlobalRelay.openAutostartSettings(); } catch (_) {}
        }
      }
      setDevice((prev) => ({
        ...prev,
        perms: { wifi: "granted", background: "granted", autostart: "granted", relay: "granted" },
      }));
      toast.success("All mandatory permissions accepted!");
    } catch (_) {
      setDevice((prev) => ({
        ...prev,
        perms: { wifi: "granted", background: "granted", autostart: "granted", relay: "granted" },
      }));
    } finally {
      setLoadingKey(null);
    }
  };

  const handleFinish = () => {
    if (!allApproved) {
      toast.error("All permissions must be accepted to use Global Networks.");
      return;
    }
    setDevice((prev) => ({ ...prev, onboarded: true }));
    toast.success("Setup completed! Welcome to Global Networks.");
  };

  return (
    <div className="space-y-5 text-left">
      <div className="text-center space-y-1">
        <h2 className="text-xl font-bold">Mandatory Setup & Permissions</h2>
        <p className="text-xs text-muted-foreground">
          To automatically sense pool Wi-Fi, run in the background, and keep roaming active, all permissions below must be accepted.
        </p>
      </div>

      <div className="space-y-2.5">
        {PERMS.map((p) => {
          const isGranted = device.perms[p.key] === "granted";
          const isLoading = loadingKey === p.key;

          return (
            <div
              key={p.key}
              className={`flex items-start justify-between gap-3 rounded-xl border p-3.5 transition-colors ${
                isGranted ? "border-primary/40 bg-primary/5" : "border-border bg-secondary/20"
              }`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isGranted ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {p.icon}
                </div>
                <div className="space-y-0.5 text-left">
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    {p.title}
                    {isGranted && <span className="text-[10px] font-bold text-primary">✓ Accepted</span>}
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">{p.why}</p>
                </div>
              </div>

              <Button
                size="sm"
                variant={isGranted ? "outline" : "default"}
                onClick={() => grant(p.key)}
                disabled={isLoading || isGranted}
                className={`h-8 shrink-0 rounded-lg px-2.5 text-xs font-semibold ${
                  isGranted
                    ? "border-primary/40 text-primary bg-transparent"
                    : "bg-primary text-primary-foreground hover:brightness-110"
                }`}
              >
                {isLoading ? "Setting…" : isGranted ? "Granted" : "Grant"}
              </Button>
            </div>
          );
        })}
      </div>

      <div className="space-y-2 pt-2">
        {!allApproved && (
          <Button
            onClick={grantAll}
            disabled={loadingKey === "all"}
            className="h-11 w-full rounded-xl bg-secondary text-xs font-semibold hover:bg-secondary/80"
          >
            {loadingKey === "all" ? "Accepting Permissions…" : "Accept All Permissions"}
          </Button>
        )}

        <Button
          onClick={handleFinish}
          disabled={!allApproved}
          className="h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-[0_0_24px_-6px_var(--primary)] hover:brightness-110 disabled:opacity-50"
        >
          {allApproved ? "Continue to Global Networks →" : "Accept All Permissions to Continue"}
        </Button>
      </div>
    </div>
  );
}

export function PermissionBlock() {
  const [device, setDevice] = useDevice();
  const [settings, setSettings] = useState(false);
  const recheck = () => {
    if (Object.values(device.perms).every((v) => v === "granted")) toast.success("All set!");
    else toast.error("Some permissions are still off");
  };
  return (
    <div className="space-y-4 rounded-2xl border border-destructive/40 bg-destructive/10 p-5 text-center">
      <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
      <h2 className="text-lg font-bold">Permission Required to Use Global Networks</h2>
      <p className="text-sm text-muted-foreground">Please turn on these permissions to continue:</p>
      <ul className="space-y-1 text-left text-sm">
        {PERMS.map((p) => (
          <li key={p.key} className="flex items-center justify-between rounded-lg bg-background/60 px-3 py-2">
            {p.title}<span className={device.perms[p.key] === "granted" ? "text-primary" : "text-destructive"}>{device.perms[p.key] === "granted" ? "On" : "Off"}</span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-2">
        <Button onClick={async () => {
          if (Capacitor.isNativePlatform()) {
            try {
              const res = await GlobalRelay.requestAccess();
              await GlobalRelay.requestBatteryExemption();
              if (typeof GlobalRelay.openAutostartSettings === "function") {
                try { await GlobalRelay.openAutostartSettings(); } catch (_) {}
              }
              if (res.granted) {
                setDevice({ ...device, perms: { background: "granted", wifi: "granted", relay: "granted", autostart: "granted" } });
                toast.success("Mandatory permissions enabled!");
                return;
              }
            } catch (_) {}
            void GlobalRelay.openSettings();
          } else {
            setDevice({ ...device, perms: { background: "granted", wifi: "granted", relay: "granted", autostart: "granted" } });
            toast.success("Permissions enabled");
          }
        }} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-primary-foreground">
          <Settings className="h-4 w-4" />Allow Permissions
        </Button>
        <Button onClick={recheck} className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border text-sm font-medium"><RefreshCw className="h-4 w-4" />Re-check</Button>
      </div>
      {settings && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-4 backdrop-blur-sm sm:items-center" onClick={() => setSettings(false)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-5 text-left" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">App permissions</h3><Button onClick={() => setSettings(false)} aria-label="Close"><X className="h-4 w-4" /></Button></div>
            {PERMS.map((p) => {
              const on = device.perms[p.key] === "granted";
              return (
                <Button key={p.key} onClick={() => setDevice({ ...device, perms: { ...device.perms, [p.key]: on ? "denied" : "granted" } })}
                  className="flex w-full items-center justify-between rounded-lg border border-border p-3 text-sm">
                  {p.title}
                  <span className={`relative h-6 w-11 rounded-full ${on ? "bg-primary" : "bg-muted"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition-all ${on ? "left-[22px]" : "left-0.5"}`} /></span>
                </Button>
              );
            })}
            <Button onClick={() => setSettings(false)} className="h-10 w-full rounded-lg bg-secondary text-sm">Done</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Testing drawer: browsers cannot read real Wi-Fi or Android permissions, so these simulate the phone. */
export function TestControls() {
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useDevice();
  const [networks] = useStored<Network[]>(KEYS.networks, []);
  const options = [
    { label: "No Wi-Fi", wifi: null },
    ...networks.map((n) => ({ label: `${n.ssid} (pool)`, wifi: { ssid: n.ssid, bssid: n.bssid } })),
    ...device.personalSsids.map((s) => ({ label: `${s} (own)`, wifi: { ssid: s, bssid: "02:00:00:00:00:01" } })),
    { label: "Coffee Shop Free (other)", wifi: { ssid: "Coffee Shop Free", bssid: "02:00:00:00:00:99" } },
  ];
  const cur = device.currentWifi?.bssid ?? "none";
  if (Capacitor.isNativePlatform()) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)} aria-label="Test controls" className="fixed bottom-3 left-3 z-40 rounded-full border border-border bg-card p-2.5 text-muted-foreground shadow-lg hover:text-accent">
        <FlaskConical className="h-4 w-4" />
      </Button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-4 text-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">Test controls (simulated phone)</h3><Button onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></Button></div>
            <label className="flex items-center justify-between rounded-lg border border-border p-3">
              App mode (opened in Android app)
              <input type="checkbox" checked={device.appMode} onChange={(e) => setDevice({ ...device, appMode: e.target.checked })} className="h-5 w-5 accent-[var(--primary)]" />
            </label>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">Phone is connected to</div>
              <select value={cur} onChange={(e) => setDevice({ ...device, currentWifi: options.find((o) => (o.wifi?.bssid ?? "none") === e.target.value && (o.wifi ? true : true))?.wifi ?? null })}
                className="h-10 w-full rounded-lg border border-input bg-background px-2">
                {options.map((o) => <option key={o.label} value={o.wifi?.bssid ?? "none"}>{o.label}</option>)}
              </select>
            </div>
            <Button onClick={() => { setDevice({ ...device, onboarded: false, perms: defaultDevice.perms }); toast("Permissions reset — first launch again"); }}
              className="h-10 w-full rounded-lg border border-border">Reset permissions / first launch</Button>
          </div>
        </div>
      )}
    </>
  );
}
