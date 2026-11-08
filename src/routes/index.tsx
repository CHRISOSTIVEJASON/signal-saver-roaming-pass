import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { ClientPortal } from "@/components/ClientPortal";
import { AdminDashboard } from "@/components/AdminDashboard";
import { useCloudIdentity } from "@/components/CloudSync";
import { AccountPanel } from "@/components/AccountPanel";
import { Button } from "@/components/ui/button";
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
  const identity = useCloudIdentity();
  const [device] = useDevice();
  const [cfg] = useConfig();
  const allGranted = Object.values(device.perms).every((v) => v === "granted");
  const body = admin && identity.admin ? <AdminDashboard onExit={() => setAdmin(false)} />
    : !device.appMode ? <DownloadGate />
    : !device.onboarded ? <Onboarding />
    : !allGranted ? <PermissionBlock />
    : <ClientPortal />;
  const mustUpdate = !admin && device.appMode && isUpdateRequired(APP_VERSION, cfg.latestVersion, cfg.updateRequired);

  const openAdmin = () => {
    if (identity.admin) setAdmin(true);
    else setPrompt(true);
  };

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-4 sm:items-center sm:py-12">
      <div className={`shimmer-border w-full rounded-3xl bg-card/95 p-4 shadow-[var(--shadow-ambient)] backdrop-blur sm:p-8 ${admin ? "max-w-5xl" : "max-w-md"}`}>
        {!admin && (
          <Button onClick={openAdmin} aria-label="Admin" className="absolute right-3 top-3 z-10 p-1 text-muted-foreground/40 transition hover:text-accent">
            <ShieldCheck className="h-4 w-4" />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => setPrompt(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between"><h2 className="font-semibold">Administrator access</h2><Button variant="ghost" size="icon" onClick={() => setPrompt(false)} aria-label="Close"><X /></Button></div>
            {identity.signedIn ? <p className="text-sm text-muted-foreground">Your account has not been assigned administrator access.</p> : <AccountPanel onDone={() => setPrompt(false)} />}
          </div>
        </div>
      )}
    </main>
  );
}
