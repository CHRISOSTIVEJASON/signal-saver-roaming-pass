import { WifiOff } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { verifyMasterPasscode } from "@/lib/cloud.functions";
import { useServerFn } from "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { ClientPortal } from "@/components/ClientPortal";
import { AdminDashboard } from "@/components/AdminDashboard";
import { Button } from "@/components/ui/button";
import { APP_VERSION, isUpdateRequired } from "@/lib/rules";
import { DownloadGate, Onboarding, PermissionBlock, TestControls, UpdateGate, useConfig, useDevice } from "@/components/Gates";
import { getPasscode } from "@/lib/store";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const [admin, setAdmin] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [device, setDevice] = useDevice();
  const [cfg] = useConfig();
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  const verifyCloudPasscode = useServerFn(verifyMasterPasscode);

  const isNative = typeof window !== "undefined" && (Capacitor.isNativePlatform() || window.location.protocol === "capacitor:" || Boolean((window as any).Capacitor?.isNativePlatform?.()));
  const isMobile = typeof navigator !== "undefined" && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isLaptopOrDesktop = typeof window !== "undefined" && !isNative && !isMobile;

  // Auto-enable app mode on native Android and on laptop/desktop web browsers
  useEffect(() => {
    if ((isNative || isLaptopOrDesktop) && (!device.appMode || (isLaptopOrDesktop && !device.onboarded))) {
      setDevice((prev) => ({
        ...prev,
        appMode: true,
        onboarded: isLaptopOrDesktop ? true : prev.onboarded,
        perms: isLaptopOrDesktop ? { background: "granted", wifi: "granted", relay: "granted" } : prev.perms,
      }));
    }
  }, [isNative, isLaptopOrDesktop, device.appMode, device.onboarded, setDevice]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const allGranted = isLaptopOrDesktop || Object.values(device.perms).every((v) => v === "granted");
  const inApp = isLaptopOrDesktop || device.appMode || isNative;
  const body = admin ? <AdminDashboard onExit={() => setAdmin(false)} />
    : !inApp ? <DownloadGate />
    : (!device.onboarded && !isLaptopOrDesktop) ? <Onboarding />
    : (!allGranted) ? <PermissionBlock />
    : <ClientPortal />;

  // Only lock native Android APK clients for APK updates; web clients always run latest web build
  const mustUpdate = !admin && inApp && isNative && isUpdateRequired(APP_VERSION, cfg.latestVersion, cfg.updateRequired);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passcode.trim()) return;
    setUnlocking(true);
    try {
      let authorized = false;
      try {
        const res = await verifyCloudPasscode({ data: { passcode: passcode.trim() } });
        if (res?.ok) {
          authorized = true;
        } else if (passcode.trim() === getPasscode()) {
          authorized = true;
        }
      } catch (err) {
        if (passcode.trim() === getPasscode()) authorized = true;
      }

      if (authorized) {
        setAdmin(true);
        setPrompt(false);
        setPasscode("");
        toast.success("Admin console unlocked");
      } else {
        toast.error("Incorrect master passcode");
      }
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-4 sm:items-center sm:py-12">
      <div className={`shimmer-border relative w-full rounded-3xl bg-card/95 p-4 shadow-[var(--shadow-ambient)] backdrop-blur sm:p-8 ${admin ? "max-w-5xl" : "max-w-md"}`}>
        {!isOnline && (
          <div className="mb-3 flex items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400">
            <WifiOff className="h-3.5 w-3.5 animate-pulse" />
            <span>No Network Connection — Local pool active</span>
          </div>
        )}

        {!admin && (
          <Button variant="ghost" size="icon" onClick={() => setPrompt(true)} aria-label="Admin" className="absolute right-3 top-3 z-10 text-muted-foreground/40 transition hover:text-accent">
            <ShieldCheck className="h-5 w-5" />
          </Button>
        )}
        <header className="mb-4 px-6 text-center">
          <h1 className="glow-text text-3xl font-bold tracking-[0.2em] sm:text-4xl">GLOBAL NETWORKS</h1>
          <p className="mt-1 text-xs uppercase tracking-[0.3em] text-muted-foreground">Internet that follows you</p>
        </header>
        {body}
      </div>

      {mustUpdate && <UpdateGate />}
      <TestControls />
      {prompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => { setPrompt(false); setPasscode(""); }}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Admin Access</h2>
              <Button variant="ghost" size="icon" onClick={() => { setPrompt(false); setPasscode(""); }} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">Enter master passcode to open administrator console.</p>
            <form onSubmit={handleUnlock} className="space-y-4">
              <input
                type="password"
                autoFocus
                placeholder="Enter master passcode"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex gap-2">
                <Button type="button" onClick={() => { setPrompt(false); setPasscode(""); }} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</Button>
                <Button type="submit" disabled={unlocking} className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                  {unlocking ? "Verifying..." : "Unlock"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
