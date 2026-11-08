import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
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
  const [device] = useDevice();
  const [cfg] = useConfig();
  const allGranted = Object.values(device.perms).every((v) => v === "granted");
  const body = admin ? <AdminDashboard onExit={() => setAdmin(false)} />
    : !device.appMode ? <DownloadGate />
    : !device.onboarded ? <Onboarding />
    : !allGranted ? <PermissionBlock />
    : <ClientPortal />;
  const mustUpdate = !admin && device.appMode && isUpdateRequired(APP_VERSION, cfg.latestVersion, cfg.updateRequired);

  const handleUnlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (passcode === getPasscode()) {
      setAdmin(true);
      setPrompt(false);
      setPasscode("");
      toast.success("Admin console unlocked");
    } else {
      toast.error("Incorrect master passcode");
    }
  };

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-4 sm:items-center sm:py-12">
      <div className={`shimmer-border relative w-full rounded-3xl bg-card/95 p-4 shadow-[var(--shadow-ambient)] backdrop-blur sm:p-8 ${admin ? "max-w-5xl" : "max-w-md"}`}>
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
                <Button type="submit" className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">Unlock</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}
