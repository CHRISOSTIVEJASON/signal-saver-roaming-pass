import { useState, type ReactNode } from "react";
import { BatteryCharging, Download, FlaskConical, RefreshCw, Settings, ShieldAlert, Share2, Wifi, X } from "lucide-react";
import { toast } from "sonner";
import { APP_VERSION } from "@/lib/rules";
import { KEYS, defaultConfig, defaultDevice, useStored, type Device, type Network, type PayConfig, type Perm } from "@/lib/store";

export const useDevice = () => useStored<Device>(KEYS.device, defaultDevice);
export const useConfig = () => {
  const [c, set] = useStored<PayConfig>(KEYS.config, defaultConfig);
  return [{ ...defaultConfig, ...c }, set] as const;
};

const PERMS: { key: keyof Device["perms"]; title: string; why: string; icon: ReactNode }[] = [
  { key: "background", title: "Run in the background", why: "Keeps your pass timer running correctly when the app is closed.", icon: <BatteryCharging className="h-5 w-5" /> },
  { key: "wifi", title: "Find nearby Wi-Fi", why: "Connects you automatically to Global Networks hotspots.", icon: <Wifi className="h-5 w-5" /> },
  { key: "relay", title: "Share connection boost", why: "Helps keep your connection strong as you move around.", icon: <Share2 className="h-5 w-5" /> },
];

function openApk(url: string) {
  if (url) window.open(url, "_blank", "noopener");
  else toast("The download link isn't ready yet. Please check back soon.");
}

export function DownloadGate() {
  const [cfg] = useConfig();
  return (
    <div className="space-y-5 text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/30 bg-primary/10">
        <Download className="h-8 w-8 text-primary" />
      </div>
      <div>
        <h2 className="text-xl font-bold">Download Global Networks Android App</h2>
        <p className="mt-2 text-sm text-muted-foreground">Buy a pass with M-Pesa and get connected automatically at any Global Networks hotspot.</p>
      </div>
      <button onClick={() => openApk(cfg.apkUrl)}
        className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-semibold text-primary-foreground shadow-[0_0_24px_-6px_var(--primary)] hover:brightness-110">
        <Download className="h-5 w-5" /> Download for Android
      </button>
      <ul className="space-y-1 text-left text-xs text-muted-foreground">
        <li>1. Tap download and open the file.</li>
        <li>2. If asked, allow installing from this source.</li>
        <li>3. Open Global Networks and pick a pass.</li>
      </ul>
      <p className="text-[11px] text-muted-foreground">Version {cfg.latestVersion || APP_VERSION}</p>
    </div>
  );
}

export function UpdateGate() {
  const [cfg] = useConfig();
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/90 p-4 backdrop-blur">
      <div role="alertdialog" aria-label="Update required" className="w-full max-w-sm space-y-4 rounded-2xl border border-accent/40 bg-card p-6 text-center shadow-[var(--shadow-ambient)]">
        <RefreshCw className="mx-auto h-10 w-10 text-accent" />
        <h2 className="text-lg font-bold">A new version is available</h2>
        <p className="text-sm text-muted-foreground">Version {cfg.latestVersion} is required to keep using Global Networks. You have {APP_VERSION}.</p>
        <button onClick={() => openApk(cfg.apkUrl)} className="h-12 w-full rounded-xl bg-accent font-semibold text-accent-foreground hover:brightness-110">Update Now</button>
      </div>
    </div>
  );
}

export function Onboarding() {
  const [device, setDevice] = useDevice();
  const [i, setI] = useState(0);
  const p = PERMS[i];
  const answer = (v: Perm) => {
    const perms = { ...device.perms, [p.key]: v };
    const done = i === PERMS.length - 1;
    setDevice({ ...device, perms, onboarded: done || device.onboarded });
    if (!done) setI(i + 1);
  };
  return (
    <div className="space-y-5">
      <div className="text-center">
        <h2 className="text-lg font-bold">Welcome! A few quick steps</h2>
        <p className="text-sm text-muted-foreground">Step {i + 1} of {PERMS.length}</p>
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-5 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">{p.icon}</div>
        <div className="font-semibold">{p.title}</div>
        <p className="text-sm text-muted-foreground">{p.why}</p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => answer("denied")} className="h-12 rounded-xl border border-border text-sm font-medium">Don't allow</button>
        <button onClick={() => answer("granted")} className="h-12 rounded-xl bg-primary text-sm font-semibold text-primary-foreground">Allow</button>
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
        <button onClick={() => setSettings(true)} className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-primary text-sm font-semibold text-primary-foreground"><Settings className="h-4 w-4" />Open Settings</button>
        <button onClick={recheck} className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border text-sm font-medium"><RefreshCw className="h-4 w-4" />Re-check Permissions</button>
      </div>
      {settings && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-4 backdrop-blur-sm sm:items-center" onClick={() => setSettings(false)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-5 text-left" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">App permissions</h3><button onClick={() => setSettings(false)} aria-label="Close"><X className="h-4 w-4" /></button></div>
            {PERMS.map((p) => {
              const on = device.perms[p.key] === "granted";
              return (
                <button key={p.key} onClick={() => setDevice({ ...device, perms: { ...device.perms, [p.key]: on ? "denied" : "granted" } })}
                  className="flex w-full items-center justify-between rounded-lg border border-border p-3 text-sm">
                  {p.title}
                  <span className={`relative h-6 w-11 rounded-full ${on ? "bg-primary" : "bg-muted"}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition-all ${on ? "left-[22px]" : "left-0.5"}`} /></span>
                </button>
              );
            })}
            <button onClick={() => setSettings(false)} className="h-10 w-full rounded-lg bg-secondary text-sm">Done</button>
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
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Test controls" className="fixed bottom-3 left-3 z-40 rounded-full border border-border bg-card p-2.5 text-muted-foreground shadow-lg hover:text-accent">
        <FlaskConical className="h-4 w-4" />
      </button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center bg-background/70 p-3 backdrop-blur-sm sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-4 text-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">Test controls (simulated phone)</h3><button onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button></div>
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
            <button onClick={() => { setDevice({ ...device, onboarded: false, perms: defaultDevice.perms }); toast("Permissions reset — first launch again"); }}
              className="h-10 w-full rounded-lg border border-border">Reset permissions / first launch</button>
          </div>
        </div>
      )}
    </>
  );
}
