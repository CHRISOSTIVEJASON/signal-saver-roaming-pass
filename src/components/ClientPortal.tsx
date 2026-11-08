import { useEffect, useRef, useState } from "react";
import { Home, Loader2, Search, Smartphone, Snowflake, Zap, Signal } from "lucide-react";
import { toast } from "sonner";
import { PASSES, connectionState, formatClock, getPass, normalizePhone, tick, type WifiState } from "@/lib/rules";
import { KEYS, defaultDevice, read, readConfig, recordRelayTick, uid, useStored, type Device, type Network, type Session, type Txn } from "@/lib/store";
import { useServerFn } from "@tanstack/react-start";
import { startCloudPayment, confirmCloudPayment, heartbeatSession } from "@/lib/cloud.functions";
import { relayProvidesConnection } from "@/lib/relay";
import { useCloudIdentity } from "./CloudSync";
import { AccountPanel } from "./AccountPanel";
import { Button } from "./ui/button";

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
  const identity = useCloudIdentity();
  const session = sessions.find((s) => s.id === activeId && s.remainingMs > 0) ?? sessions.find((s) => s.remainingMs > 0);
  if (!identity.signedIn) return <AccountPanel />;

  if (session) return <ActiveSession session={session} setSessions={setSessions} onEnd={() => setActiveId(null)} />;
  return <Purchase onActivated={(s) => { setActiveId(s.id); }} />;
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
  async function pay() {
    const msisdn = normalizePhone(phone);
    if (!msisdn) { toast.error("Enter a valid Safaricom number (07… or 01…)"); return; }
    try {
      setBusy("Sending M-Pesa prompt…");
      const payment = await startPayment({ data: { phone: msisdn, passId: pass.id } });
      setBusy(payment.live ? "Enter your M-Pesa PIN…" : "Confirming demo payment…");
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, payment.live ? 3000 : 1000));
        const result = await confirmPayment({ data: { id: payment.id } });
        if (result.session) { onActivated(result.session); toast.success(payment.live ? "Payment received — pass activated!" : "Demo pass activated — no money charged"); return; }
      }
      toast.error("Payment is still pending. Check before paying again.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Payment failed"); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-center"><NetworkBadge /></div>
      <div className="grid grid-cols-2 gap-3">
        {PASSES.map((p) => (
          <Button key={p.id} onClick={() => setPassId(p.id)}
            className={`relative rounded-xl border p-3 text-left transition ${passId === p.id ? "border-primary bg-primary/10 shadow-[0_0_24px_-6px_var(--primary)]" : "border-border bg-secondary/40 hover:border-accent/50"}`}>
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
      </div>
    </div>
  );
}

function ActiveSession({ session, setSessions, onEnd }: { session: Session; setSessions: (f: (p: Session[]) => Session[]) => void; onEnd: () => void }) {
  const [, force] = useState(0);
  const ref = useRef(session);
  ref.current = session;
  const { state, ssid, direct } = useWifiState();
  const sendHeartbeat = useServerFn(heartbeatSession);

  useEffect(() => {
    const step = () => {
      const now = Date.now();
      const device = read<Device>(KEYS.device, defaultDevice);
      void sendHeartbeat({ data: { id: ref.current.id, bssid: device.currentWifi?.bssid ?? null, relayReady: relayProvidesConnection(device.relay, now) } }).catch(() => toast.error("Pass sync interrupted"));
      force((n) => n + 1);
    };
    step();
    const t = setInterval(step, 10_000);
    const display = setInterval(() => force((n) => n + 1), 1000);
    return () => { clearInterval(t); clearInterval(display); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const remainingMs = tick(session.remainingMs, session.lastTick, Math.min(Date.now(), session.lastTick + 30_000), session.online);
  const pct = (remainingMs / session.totalMs) * 100;
  const pass = getPass(session.passId);
  const running = state === "pool";

  return (
    <div className="space-y-5 text-center">
      {direct && <span className="inline-flex items-center justify-center gap-2 text-sm text-primary"><Signal className="h-5 w-5 shrink-0" />Connected to GLOBAL NETWORKS (High-Speed Direct Relay)</span>}
      {state === "pool" && !direct && <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"><Zap className="h-3.5 w-3.5" />Connected automatically • {ssid}</span>}
      {state === "personal" && <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent"><Home className="h-3.5 w-3.5" />On your own Wi-Fi — your pass time is saved</span>}
      {state === "searching" && <span className="inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning"><Snowflake className="h-3.5 w-3.5" />Time Frozen — searching for network</span>}
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Time remaining</div>
        <div className={`font-mono text-5xl font-bold tabular-nums sm:text-6xl ${running ? "glow-text" : "text-warning"}`}>{formatClock(remainingMs)}</div>
        <div className="mt-1 text-sm text-muted-foreground">{pass.label} • +{session.phone}</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full transition-all ${running ? "bg-primary" : "bg-warning"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">Your time only counts down while you're on a Global Networks hotspot. No password needed — we connect you automatically.</p>
      <Button onClick={onEnd} className="text-xs text-muted-foreground underline-offset-4 hover:underline">Buy another pass</Button>
    </div>
  );
}
