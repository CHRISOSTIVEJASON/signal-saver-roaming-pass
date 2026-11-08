import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { ClientPortal } from "@/components/ClientPortal";
import { AdminDashboard } from "@/components/AdminDashboard";
import { getPasscode } from "@/lib/store";
import { APP_VERSION, isUpdateRequired } from "@/lib/rules";
import { DownloadGate, Onboarding, PermissionBlock, TestControls, UpdateGate, useConfig, useDevice } from "@/components/Gates";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Global Networks — High-speed internet everywhere" },
      { name: "description", content: "Buy a Global Networks pass with M-Pesa and get fast internet that works everywhere." },
      { property: "og:title", content: "Global Networks — High-speed internet everywhere" },
      { property: "og:description", content: "Pay with M-Pesa from KES 10 and stay connected wherever you go." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [admin, setAdmin] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const [code, setCode] = useState("");
  const [device] = useDevice();
  const [cfg] = useConfig();
  const allGranted = Object.values(device.perms).every((v) => v === "granted");
  const body = admin ? <AdminDashboard onExit={() => setAdmin(false)} />
    : !device.appMode ? <DownloadGate />
    : !device.onboarded ? <Onboarding />
    : !allGranted ? <PermissionBlock />
    : <ClientPortal />;
  const mustUpdate = !admin && device.appMode && isUpdateRequired(APP_VERSION, cfg.latestVersion, cfg.updateRequired);

  const unlock = (e: React.FormEvent) => {
    e.preventDefault();
    if (code === getPasscode()) { setAdmin(true); setPrompt(false); setCode(""); }
    else toast.error("Incorrect passcode");
  };

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-4 sm:items-center sm:py-12">
      <div className={`shimmer-border w-full rounded-3xl bg-card/95 p-4 shadow-[var(--shadow-ambient)] backdrop-blur sm:p-8 ${admin ? "max-w-5xl" : "max-w-md"}`}>
        {!admin && (
          <button onClick={() => setPrompt(true)} aria-label="Admin" className="absolute right-3 top-3 z-10 p-1 text-muted-foreground/40 transition hover:text-accent">
            <ShieldCheck className="h-4 w-4" />
          </button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => setPrompt(false)}>
          <form onSubmit={unlock} onClick={(e) => e.stopPropagation()} className="w-full max-w-xs space-y-4 rounded-2xl border border-border bg-card p-4 shadow-[var(--shadow-ambient)]">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-semibold"><ShieldCheck className="h-4 w-4 text-accent" />Master Passcode</h2>
              <button type="button" onClick={() => setPrompt(false)} aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <input autoFocus type="password" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)}
              className="h-12 w-full rounded-lg border border-input bg-background px-3 text-center font-mono text-xl tracking-[0.5em] outline-none focus:ring-2 focus:ring-ring" />
            <button className="h-10 w-full rounded-lg bg-accent text-sm font-semibold text-accent-foreground">Unlock</button>
          </form>
        </div>
      )}
    </main>
  );
}
