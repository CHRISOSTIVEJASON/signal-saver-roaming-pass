import { useEffect, useRef, useState } from "react";
import { Home, Loader2, Search, Smartphone, Snowflake, Zap, Signal } from "lucide-react";
import { toast } from "sonner";
import { PASSES, connectionState, formatClock, getPass, normalizePhone, tick, type WifiState } from "@/lib/rules";
import { KEYS, defaultDevice, defaultConfig, read, recordRelayTick, uid, useStored, type Device, type Network, type Session, type Txn, type PayConfig } from "@/lib/store";
import { useServerFn } from "@tanstack/react-start";
import { startCloudPayment, confirmCloudPayment, restoreCloudPass } from "@/lib/cloud.functions";
import { contributeNetworkAndCaptive } from "@/lib/captive.functions";
import { saveShared } from "@/lib/cloud-cache";
import { GlobalRelay } from "@/lib/native-relay";
import { getDeviceId } from "@/lib/store";
import { X } from "lucide-react";
import { relayProvidesConnection } from "@/lib/relay";
import { Button } from "./ui/button";
import { Capacitor } from "@capacitor/core";
import { CaptiveLogin } from "./CaptiveLogin";

function currentState(): { state: WifiState; ssid: string | undefined } {
  const d = read<Device>(KEYS.device, defaultDevice);
  const nets = read<Network[]>(KEYS.networks, []);
  return { state: relayProvidesConnection(d.relay, Date.now()) ? "pool" : connectionState(d.currentWifi, nets.map((n) => n.bssid), d.personalSsids), ssid: d.currentWifi?.ssid };
}

/** Live Wi-Fi state, re-read whenever the device or pool changes. */
function useWifiState() {
  const [device] = useStored<Device>(KEYS.device, defaultDevice);
  const [nets] = useStored<Network[]>(KEYS.networks, []);
  return { state: relayProvidesConnection(device.relay, Date.now()) ? "pool" : connectionState(device.currentWifi, nets.map((n) => n.bssid), device.personalSsids), ssid: device.currentWifi?.ssid, direct: relayProvidesConnection(device.relay, Date.now()) };
}

export function ClientPortal() {
  const [activeId, setActiveId] = useStored<string | null>(KEYS.active, null);
  const [sessions, setSessions] = useStored<Session[]>(KEYS.sessions, []);
  const [buying, setBuying] = useState(false);
  const session = sessions.find((s) => s.id === activeId && s.remainingMs > 0) ?? sessions.find((s) => s.remainingMs > 0);

  if (session && !buying) return <ActiveSession session={session} setSessions={setSessions} onEnd={() => setBuying(true)} />;
  return <Purchase onActivated={(s) => { setSessions((p) => [s, ...p]); setActiveId(s.id); setBuying(false); }} />;
}


function NetworkBadge() {
  const { state } = useWifiState();
  if (state === "pool")
    return <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" />Network Available</span>;
  return <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground"><Search className="h-3.5 w-3.5" />Searching for network…</span>;
}

function Purchase({ onActivated }: { onActivated: (s: Session) => void }) {
  const [passId, setPassId] = useState<string>("p30");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [, setTxns] = useStored<Txn[]>(KEYS.txns, []);
  const pass = getPass(passId);

  const startPayment = useServerFn(startCloudPayment);
  const confirmPayment = useServerFn(confirmCloudPayment);
  const restorePass = useServerFn(restoreCloudPass);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePhone, setRestorePhone] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);

  const updateTxn = (id: string, patch: Partial<Txn>) =>
    setTxns((p) => p.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  async function pay() {
    const msisdn = normalizePhone(phone);
    if (!msisdn) { toast.error("Enter a valid Safaricom number (07… or 01…)"); return; }
    const cfg = read<PayConfig>(KEYS.config, defaultConfig);
    const live = Boolean(cfg.live);
    const txnId = uid();
    let ref = "GN" + uid();
    setTxns((p) => [{ id: txnId, phone: msisdn, amount: pass.amount, passId, ref, at: Date.now(), status: "Pending", mode: live ? "Live" : "Demo" }, ...p]);

    try {
      if (live) {
        setBusy("Sending M-Pesa prompt to your phone…");
        const deviceId = getDeviceId();
        const r = await startPayment({ data: { phone: msisdn, passId: pass.id as 'p15' | 'p30', deviceId } });
        if (r.ref) ref = r.ref;
        updateTxn(txnId, { ref });
        setBusy("Enter your M-Pesa PIN on your phone…");
        let ok = false;
        let activatedSession: Session | null = null;
        for (let i = 0; i < 30 && !ok; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          const st = await confirmPayment({ data: { id: r.id, deviceId } });
          if (!st.pending && st.session) {
            ok = true;
            activatedSession = st.session;
          }
        }
        if (!ok || !activatedSession) throw new Error("Payment timed out. If you already completed payment, tap 'Restore Active Pass'.");
        updateTxn(txnId, { status: "Activated" });
        onActivated(activatedSession);
        toast.success("Payment received — pass activated!");
      } else {
        setBusy("Sending M-Pesa prompt to your phone…");
        await new Promise((r) => setTimeout(r, 1200));
        setBusy("Confirming payment…");
        await new Promise((r) => setTimeout(r, 1200));
        ref = "S" + uid() + "K";
        updateTxn(txnId, { ref, status: "Activated" });
        const now = Date.now();
        const ms = pass.hours * 3600_000;
        const s: Session = { id: uid(), phone: msisdn, passId, totalMs: ms, remainingMs: ms, lastTick: now, online: true, startedAt: now };
        onActivated(s);
        toast.success("Demo pass activated — no money charged");
      }
    } catch (e) {
      updateTxn(txnId, { status: "Failed" });
      toast.error(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore(e: React.FormEvent) {
    e.preventDefault();
    const msisdn = normalizePhone(restorePhone);
    if (!msisdn) {
      toast.error("Enter a valid Safaricom phone number (07… or 01…)");
      return;
    }
    setRestoreBusy(true);
    try {
      const res = await restorePass({ data: { phone: msisdn, deviceId: getDeviceId() } });
      if (res?.session) {
        onActivated(res.session);
        toast.success("Active pass restored!");
        setRestoreOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to restore pass");
    } finally {
      setRestoreBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-center"><NetworkBadge /></div>
      <div className="grid grid-cols-2 gap-3">
        {PASSES.map((p) => (
          <Button variant="outline" disabled={Boolean(busy)} key={p.id} onClick={() => setPassId(p.id)}
            className={`relative flex h-24 flex-col items-start gap-1 whitespace-normal rounded-lg border p-3 text-left transition ${passId === p.id ? "border-primary bg-primary/10 shadow-[0_0_24px_-6px_var(--primary)]" : "border-border bg-secondary/40 hover:border-accent/50"}`}>
            {p.popular && <span className="absolute -top-2.5 right-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase text-accent-foreground">Best Value</span>}
            <div className="font-mono text-2xl font-bold"><span className="text-xs font-normal text-muted-foreground">KES </span>{p.amount}</div>
            <div className="text-sm">{p.label}</div>
          </Button>
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          <input id="phone" aria-label="M-Pesa phone number" inputMode="tel" placeholder="M-Pesa number 07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)}
            className="h-12 w-full bg-transparent font-mono text-base outline-none" disabled={!!busy} />
        </div>
        <Button onClick={pay} disabled={!!busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-70">
          {busy ? <><Loader2 className="h-4 w-4 animate-spin" />{busy}</> : <>⚡ Pay KES {pass.amount} via M-Pesa</>}
        </Button>
        <p className="text-center text-xs text-muted-foreground">You'll get a prompt on your phone. Enter your PIN to confirm.</p>
        <div className="pt-2 text-center">
          <Button
            variant="ghost"
            type="button"
            onClick={() => setRestoreOpen(true)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Reinstalled app? Restore Active Pass
          </Button>
        </div>
      </div>
      {restoreOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => setRestoreOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">Restore Active Pass</h3>
              <Button variant="ghost" size="icon" onClick={() => setRestoreOpen(false)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">Enter the M-Pesa phone number you used to purchase your pass to regain access on this device.</p>
            <form onSubmit={handleRestore} className="space-y-3">
              <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
                <Smartphone className="h-4 w-4 text-muted-foreground" />
                <input
                  autoFocus
                  type="tel"
                  placeholder="07XX XXX XXX"
                  value={restorePhone}
                  onChange={(e) => setRestorePhone(e.target.value)}
                  className="h-10 w-full bg-transparent font-mono text-sm outline-none"
                />
              </div>
              <div className="flex gap-2">
                <Button type="button" onClick={() => setRestoreOpen(false)} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</Button>
                <Button type="submit" disabled={restoreBusy} className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                  {restoreBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Restore Pass"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveSession({ session, setSessions, onEnd }: { session: Session; setSessions: (f: (p: Session[]) => Session[]) => void; onEnd: () => void }) {
  const [, force] = useState(0);
  const ref = useRef(session);
  ref.current = session;
  const { state, ssid, direct } = useWifiState();
  const [deviceState] = useStored<Device>(KEYS.device, defaultDevice);
  const connecting = Capacitor.isNativePlatform() && state === "pool" && !direct && (!deviceState.captive?.ready || deviceState.captive.bssid !== deviceState.currentWifi?.bssid);

  const update = (patch: (s: Session) => Partial<Session>) =>
    setSessions((p) => p.map((s) => (s.id === ref.current.id ? { ...s, ...patch(s) } : s)));

  useEffect(() => {
    const step = () => {
      const now = Date.now();
      const running = state === "pool" && !connecting;
      update((s) => ({ remainingMs: tick(s.remainingMs, s.lastTick, now, running), lastTick: now, online: running }));
      if (ref.current.online) recordRelayTick(ref.current.phone);
      force((n) => n + 1);
    };
    step();
    const t = setInterval(step, 1000);
    return () => clearInterval(t);
  }, [session.id, state, connecting]);

  const remainingMs = tick(session.remainingMs, session.lastTick, Math.min(Date.now(), session.lastTick + 30_000), session.online);
  const pct = (remainingMs / session.totalMs) * 100;
  const pass = getPass(session.passId);

  return (
    <div className="space-y-5 text-center">
      <CaptiveLogin sessionId={session.id} />
      {connecting && <span className="inline-flex items-center gap-2 text-sm text-warning"><Loader2 className="h-4 w-4 animate-spin" />Connecting — your time is preserved</span>}
      {direct && <span className="inline-flex items-center justify-center gap-2 text-sm text-primary"><Signal className="h-5 w-5 shrink-0" />Connected to GLOBAL NETWORKS (High-Speed Direct Relay)</span>}
      {state === "pool" && !direct && !connecting && <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"><Zap className="h-3.5 w-3.5" />Connected automatically • {ssid}</span>}
      {state === "personal" && <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent"><Home className="h-3.5 w-3.5" />On your own Wi-Fi — your pass time is saved</span>}
      {state === "searching" && <span className="inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning"><Snowflake className="h-3.5 w-3.5" />Time Frozen — searching for network</span>}
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Time remaining</div>
        <div className={`font-mono text-5xl font-bold tabular-nums sm:text-6xl ${session.online ? "glow-text" : "text-warning"}`}>
          {formatClock(remainingMs)}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">{pass.label} • +{session.phone}</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full transition-all ${session.online ? "bg-primary" : "bg-warning"}`} style={{ width: `${pct}%` }} />
      </div>
            <div className="pt-2 flex flex-col gap-2">
        <Button variant="ghost" onClick={onEnd} className="text-xs text-muted-foreground underline-offset-4 hover:underline">Buy another pass</Button>
      </div>
    </div>
  );
}
