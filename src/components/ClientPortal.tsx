import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Wifi, WifiOff, Zap, Pause, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { PASSES, formatClock, getPass, normalizePhone, tick } from "@/lib/rules";
import { KEYS, defaultConfig, read, recordRelayTick, uid, useStored, type PayConfig, type Session, type Txn } from "@/lib/store";
import { checkStkStatus, initiateStkPush } from "@/lib/payhero.functions";

export function ClientPortal() {
  const [activeId, setActiveId] = useStored<string | null>(KEYS.active, null);
  const [sessions, setSessions] = useStored<Session[]>(KEYS.sessions, []);
  const session = sessions.find((s) => s.id === activeId && s.remainingMs > 0);

  if (session) return <ActiveSession session={session} setSessions={setSessions} onEnd={() => setActiveId(null)} />;
  return <Purchase onActivated={(s) => { setSessions((p) => [s, ...p]); setActiveId(s.id); }} />;
}

function Purchase({ onActivated }: { onActivated: (s: Session) => void }) {
  const [passId, setPassId] = useState<string>("p30");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [, setTxns] = useStored<Txn[]>(KEYS.txns, []);
  const pass = getPass(passId);

  const updateTxn = (id: string, patch: Partial<Txn>) => setTxns((p) => p.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  async function pay() {
    const msisdn = normalizePhone(phone);
    if (!msisdn) { toast.error("Enter a valid Safaricom number (07… or 01…)"); return; }
    const cfg = read<PayConfig>(KEYS.config, defaultConfig);
    const live = cfg.live && cfg.channelId && (cfg.apiToken || (cfg.username && cfg.password));
    const txnId = uid();
    let ref = "GN" + uid();
    setTxns((p) => [{ id: txnId, phone: msisdn, amount: pass.amount, passId, ref, at: Date.now(), status: "Pending", mode: live ? "Live" : "Demo" }, ...p]);
    try {
      if (live) {
        setBusy("Sending M-Pesa prompt to your phone…");
        const creds = { apiToken: cfg.apiToken, username: cfg.username, password: cfg.password, channelId: cfg.channelId };
        const r = await initiateStkPush({ data: { ...creds, phone: msisdn, amount: pass.amount, reference: ref } });
        if (!r.ok) throw new Error(r.error);
        if (r.reference) ref = r.reference;
        updateTxn(txnId, { ref });
        setBusy("Enter your M-Pesa PIN on your phone…");
        let ok = false;
        for (let i = 0; i < 30 && !ok; i++) {
          await new Promise((res) => setTimeout(res, 3000));
          const st = await checkStkStatus({ data: { ...creds, reference: ref } });
          if (st.status === "SUCCESS") { ok = true; if (st.receipt) { ref = st.receipt; updateTxn(txnId, { ref }); } }
          else if (st.status === "FAILED" || st.status === "CANCELLED") throw new Error("Payment was cancelled or failed");
        }
        if (!ok) throw new Error("Payment timed out. Please try again.");
      } else {
        setBusy("Sending M-Pesa prompt to your phone…");
        await new Promise((r) => setTimeout(r, 1500));
        setBusy("Confirming payment…");
        await new Promise((r) => setTimeout(r, 1500));
        ref = "S" + uid() + "K";
        updateTxn(txnId, { ref });
      }
      updateTxn(txnId, { status: "Activated" });
      const now = Date.now();
      const ms = pass.hours * 3600_000;
      onActivated({ id: uid(), phone: msisdn, passId, totalMs: ms, remainingMs: ms, lastTick: now, online: true, startedAt: now });
      toast.success("Payment received — you're connected!");
    } catch (e) {
      updateTxn(txnId, { status: "Failed" });
      toast.error(e instanceof Error ? e.message : "Payment failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          🟢 Network Available
        </span>
      </div>
      <p className="text-center text-sm text-muted-foreground">Fast, reliable internet that works everywhere you go. Pick a pass and connect in seconds.</p>

      <div className="grid grid-cols-2 gap-3">
        {PASSES.map((p) => (
          <button key={p.id} onClick={() => setPassId(p.id)}
            className={`relative rounded-xl border p-4 text-left transition ${passId === p.id ? "border-primary bg-primary/10 shadow-[0_0_24px_-6px_var(--primary)]" : "border-border bg-secondary/40 hover:border-accent/50"}`}>
            {p.popular && <span className="absolute -top-2.5 right-2 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase text-accent-foreground">Best Value</span>}
            <div className="text-xs text-muted-foreground">KES</div>
            <div className="font-mono text-3xl font-bold">{p.amount}</div>
            <div className="mt-1 text-sm">{p.label}</div>
          </button>
        ))}
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-4">
        <label className="text-sm font-medium" htmlFor="phone">M-Pesa phone number</label>
        <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          <input id="phone" inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)}
            className="h-12 w-full bg-transparent font-mono text-base outline-none" disabled={!!busy} />
        </div>
        <button onClick={pay} disabled={!!busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground transition hover:brightness-110 disabled:opacity-70">
          {busy ? <><Loader2 className="h-4 w-4 animate-spin" />{busy}</> : <>⚡ Pay KES {pass.amount} via M-Pesa & Connect</>}
        </button>
        <p className="text-center text-xs text-muted-foreground">You'll get a prompt on your phone. Enter your PIN to confirm.</p>
      </div>
      <ApkBanner />
    </div>
  );
}

function ActiveSession({ session, setSessions, onEnd }: { session: Session; setSessions: (f: (p: Session[]) => Session[]) => void; onEnd: () => void }) {
  const [, force] = useState(0);
  const ref = useRef(session);
  ref.current = session;

  const update = (patch: (s: Session) => Partial<Session>) =>
    setSessions((p) => p.map((s) => (s.id === ref.current.id ? { ...s, ...patch(s) } : s)));

  useEffect(() => {
    const step = () => {
      const now = Date.now();
      update((s) => ({ remainingMs: tick(s.remainingMs, s.lastTick, now, s.online), lastTick: now }));
      if (ref.current.online) recordRelayTick(ref.current.phone);
      force((n) => n + 1);
    };
    step();
    const t = setInterval(step, 1000);
    const goOff = () => update(() => ({ online: false }));
    const goOn = () => update(() => ({ online: true, lastTick: Date.now() }));
    window.addEventListener("offline", goOff);
    window.addEventListener("online", goOn);
    return () => { clearInterval(t); window.removeEventListener("offline", goOff); window.removeEventListener("online", goOn); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const toggle = () => {
    const now = Date.now();
    update((s) => ({ remainingMs: tick(s.remainingMs, s.lastTick, now, s.online), lastTick: now, online: !s.online }));
  };
  const pct = (session.remainingMs / session.totalMs) * 100;
  const pass = getPass(session.passId);

  return (
    <div className="space-y-6 text-center">
      {session.online ? (
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
          <Zap className="h-3.5 w-3.5" /> Online • High Speed
        </span>
      ) : (
        <span className="inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning">
          <Pause className="h-3.5 w-3.5" /> Time Frozen — Your balance is preserved until reconnected
        </span>
      )}
      <div>
        <div className="text-xs uppercase tracking-widest text-muted-foreground">Time remaining</div>
        <div className={`font-mono text-5xl font-bold tabular-nums sm:text-6xl ${session.online ? "glow-text" : "text-warning"}`}>
          {formatClock(session.remainingMs)}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">{pass.label} • +{session.phone}</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className={`h-full transition-all ${session.online ? "bg-primary" : "bg-warning"}`} style={{ width: `${pct}%` }} />
      </div>
      <button onClick={toggle}
        className={`flex w-full items-center justify-between rounded-xl border p-4 text-left transition ${session.online ? "border-primary/30 bg-primary/5" : "border-warning/40 bg-warning/10"}`}>
        <span className="flex items-center gap-3">
          {session.online ? <Wifi className="h-5 w-5 text-primary" /> : <WifiOff className="h-5 w-5 text-warning" />}
          <span>
            <span className="block text-sm font-semibold">{session.online ? "Connected to Network" : "Signal Lost / Offline"}</span>
            <span className="block text-xs text-muted-foreground">Tap to simulate signal change</span>
          </span>
        </span>
        <span className={`relative h-6 w-11 rounded-full transition ${session.online ? "bg-primary" : "bg-muted"}`}>
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-background transition-all ${session.online ? "left-[22px]" : "left-0.5"}`} />
        </span>
      </button>
      <ApkBanner />
      <button onClick={onEnd} className="text-xs text-muted-foreground underline-offset-4 hover:underline">Buy another pass</button>
    </div>
  );
}

function ApkBanner() {
  const [cfg] = useStored<PayConfig>(KEYS.config, defaultConfig);
  const download = () => {
    if (cfg.apkUrl) window.open(cfg.apkUrl, "_blank", "noopener");
    else toast("The Android app will be available for download soon.");
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/10 p-3 text-left">
      <Download className="h-8 w-8 shrink-0 text-accent" />
      <div className="flex-1">
        <div className="text-sm font-semibold">Stay connected on the go</div>
        <div className="text-xs text-muted-foreground">Get the app to keep your pass running in the background.</div>
      </div>
      <button onClick={download} className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground hover:brightness-110">
        Download Android App (APK)
      </button>
    </div>
  );
}
