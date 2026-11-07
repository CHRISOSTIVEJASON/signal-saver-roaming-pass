import { useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, LogOut, Plus, Radio, Trash2, Users, Wallet, Wifi, Database, X } from "lucide-react";
import { toast } from "sonner";
import { changePasscode, formatClock, getPass, tick } from "@/lib/rules";
import { KEYS, defaultConfig, emptyRelay, uid, type RelayLog, useStored, write, type Network, type PayConfig, type Session, type Txn } from "@/lib/store";

const GB_PER_HOUR = 0.35;

export function AdminDashboard({ onExit }: { onExit: () => void }) {
  const [txns] = useStored<Txn[]>(KEYS.txns, []);
  const [sessions] = useStored<Session[]>(KEYS.sessions, []);
  const [networks] = useStored<Network[]>(KEYS.networks, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const live = sessions.map((s) => ({ ...s, remainingMs: tick(s.remainingMs, s.lastTick, now, s.online) }));
  const active = live.filter((s) => s.remainingMs > 0);
  const revenue = txns.filter((t) => t.status === "Activated").reduce((a, t) => a + t.amount, 0);
  const gb = live.reduce((a, s) => a + ((s.totalMs - s.remainingMs) / 3600_000) * GB_PER_HOUR, 0);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-accent">Admin Console</div>
          <h2 className="text-xl font-bold">Dashboard</h2>
        </div>
        <button onClick={onExit} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">
          <LogOut className="h-4 w-4" /> Exit Admin
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon={<Wallet />} label="Total Revenue" value={`KES ${revenue.toLocaleString()}`} />
        <Metric icon={<Users />} label="Active Roaming Clients" value={active.length} />
        <Metric icon={<Wifi />} label="Wi-Fi Networks in Pool" value={networks.length} />
        <Metric icon={<Database />} label="Live Data Consumed" value={`${gb.toFixed(2)} GB`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <PayHeroCard />
        <PasscodeCard />
      </div>
      <PoolManager />
      <Panel title="Live Clients & Roaming Monitor" icon={<Radio className="h-4 w-4" />}>
        <Table head={["Phone", "Pass", "Time remaining", "State"]} empty="No active sessions yet."
          rows={active.map((s) => [
            `+${s.phone}`, getPass(s.passId).label, <span className="font-mono">{formatClock(s.remainingMs)}</span>,
            s.online ? <Pill tone="primary">Active</Pill> : <Pill tone="warning">Frozen</Pill>,
          ])} />
      </Panel>
      <RelayMonitor />
      <Panel title="M-Pesa Transactions Log" icon={<Wallet className="h-4 w-4" />}>
        <Table head={["Time", "Phone", "Amount", "Reference", "Mode", "Status"]} empty="No transactions yet."
          rows={txns.map((t) => [
            new Date(t.at).toLocaleString(), `+${t.phone}`, `KES ${t.amount}`, <span className="font-mono text-xs">{t.ref}</span>, t.mode,
            <Pill tone={t.status === "Activated" ? "primary" : t.status === "Failed" ? "destructive" : "warning"}>{t.status}</Pill>,
          ])} />
      </Panel>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-4">
      <div className="mb-2 text-accent [&>svg]:h-4 [&>svg]:w-4">{icon}</div>
      <div className="font-mono text-xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Panel({ title, icon, action, children }: { title: string; icon: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-secondary/30 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold"><span className="text-primary">{icon}</span>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function Pill({ tone, children }: { tone: "primary" | "warning" | "destructive"; children: ReactNode }) {
  const c = { primary: "bg-primary/15 text-primary", warning: "bg-warning/15 text-warning", destructive: "bg-destructive/15 text-destructive" }[tone];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
}

function Table({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[520px] text-sm">
        <thead><tr className="text-left text-xs uppercase text-muted-foreground">{head.map((h) => <th key={h} className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="py-2 pr-3">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const inputCls = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block space-y-1"><span className="text-xs text-muted-foreground">{label}</span>{children}</label>;
}

function Secret({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={inputCls + " pr-10"} autoComplete="off" />
      <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-2.5 text-muted-foreground" aria-label="Toggle visibility">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function PayHeroCard() {
  const [saved, setSaved] = useStored<PayConfig>(KEYS.config, defaultConfig);
  const [c, setC] = useState(saved);
  useEffect(() => setC(saved), [saved]);
  const set = (k: keyof PayConfig) => (v: string | boolean) => setC({ ...c, [k]: v });
  const save = () => {
    if (c.live && (!c.channelId || !(c.apiToken || (c.username && c.password))))
      return toast.error("Live mode needs a Channel ID and either an API token or username + password");
    setSaved(c); toast.success("PayHero settings saved");
  };
  return (
    <Panel title="PayHero Configuration" icon={<KeyRound className="h-4 w-4" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-background p-1 text-sm">
          {[false, true].map((l) => (
            <button key={String(l)} onClick={() => set("live")(l)}
              className={`rounded-md py-2 font-medium ${c.live === l ? (l ? "bg-primary text-primary-foreground" : "bg-secondary") : "text-muted-foreground"}`}>
              {l ? "Live PayHero STK Push" : "Demo Simulation Mode"}
            </button>
          ))}
        </div>
        <Field label="API Key / Basic Auth Token"><Secret value={c.apiToken} onChange={set("apiToken")} placeholder="Basic xxxxx (optional if username/password set)" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username"><input className={inputCls} value={c.username} onChange={(e) => set("username")(e.target.value)} autoComplete="off" /></Field>
          <Field label="Password"><Secret value={c.password} onChange={set("password")} /></Field>
        </div>
        <Field label="Channel ID"><input className={inputCls} inputMode="numeric" value={c.channelId} onChange={(e) => set("channelId")(e.target.value)} /></Field>
        <Field label="Android APK download link"><input className={inputCls} value={c.apkUrl} placeholder="https://…/global-networks.apk" onChange={(e) => set("apkUrl")(e.target.value)} /></Field>
        <button onClick={save} className="h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:brightness-110">Save Configuration</button>
      </div>
    </Panel>
  );
}

function PasscodeCard() {
  const [step, setStep] = useState<"idle" | "security" | "new">("idle");
  const [sec, setSec] = useState("");
  const [pass, setPass] = useState("");
  const verify = () => {
    if (sec !== "2006") { toast.error("Invalid security code"); return; }
    setStep("new");
  };
  const save = () => {
    const r = changePasscode(sec, pass);
    if (!r.ok) return toast.error(r.error);
    write(KEYS.passcode, r.passcode);
    toast.success("Master passcode updated");
    setStep("idle"); setSec(""); setPass("");
  };
  return (
    <Panel title="Master Passcode" icon={<KeyRound className="h-4 w-4" />}>
      {step === "idle" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Change the passcode used to open this dashboard. A security code is required.</p>
          <button onClick={() => setStep("security")} className="h-10 w-full rounded-lg border border-border text-sm font-medium hover:bg-secondary">Change Passcode</button>
        </div>
      )}
      {step === "security" && (
        <div className="space-y-3">
          <Field label="Enter Security Code"><Secret value={sec} onChange={setSec} /></Field>
          <div className="flex gap-2">
            <button onClick={() => { setStep("idle"); setSec(""); }} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</button>
            <button onClick={verify} className="h-10 flex-1 rounded-lg bg-accent text-sm font-semibold text-accent-foreground">Verify</button>
          </div>
        </div>
      )}
      {step === "new" && (
        <div className="space-y-3">
          <Field label="New Master Passcode"><Secret value={pass} onChange={setPass} /></Field>
          <div className="flex gap-2">
            <button onClick={() => { setStep("idle"); setSec(""); setPass(""); }} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</button>
            <button onClick={save} className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">Save Passcode</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PoolManager() {
  const [networks, setNetworks] = useStored<Network[]>(KEYS.networks, []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ ssid: "", bssid: "", venue: "" });
  const add = () => {
    if (!f.ssid.trim() || !f.bssid.trim()) return toast.error("Wi-Fi name and BSSID are required");
    if (!/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(f.bssid.trim())) return toast.error("BSSID must look like AA:BB:CC:DD:EE:FF");
    setNetworks((p) => [{ id: uid(), ssid: f.ssid.trim(), bssid: f.bssid.trim().toUpperCase().replace(/-/g, ":"), venue: f.venue.trim(), addedAt: Date.now() }, ...p]);
    setF({ ssid: "", bssid: "", venue: "" }); setOpen(false); toast.success("Wi-Fi stamped into the pool");
  };
  return (
    <Panel title="Wi-Fi Master Pool" icon={<Wifi className="h-4 w-4" />}
      action={<button onClick={() => setOpen(true)} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"><Plus className="h-3.5 w-3.5" />Stamp New Wi-Fi</button>}>
      <Table head={["SSID", "BSSID / MAC", "Venue", ""]} empty="No networks stamped yet."
        rows={networks.map((n) => [
          <span className="font-medium">{n.ssid}</span>, <span className="font-mono text-xs">{n.bssid}</span>, n.venue || "—",
          <button onClick={() => { setNetworks((p) => p.filter((x) => x.id !== n.id)); toast("Removed from pool"); }}
            className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-1 text-xs font-medium text-destructive-foreground"><Trash2 className="h-3 w-3" />Remove from Pool</button>,
        ])} />
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-background/80 p-4 backdrop-blur-sm sm:items-center" onClick={() => setOpen(false)}>
          <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-ambient)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between"><h3 className="font-semibold">Stamp New Wi-Fi</h3><button onClick={() => setOpen(false)} aria-label="Close"><X className="h-4 w-4" /></button></div>
            <Field label="Wi-Fi Name (SSID)"><input className={inputCls} value={f.ssid} onChange={(e) => setF({ ...f, ssid: e.target.value })} /></Field>
            <Field label="Router BSSID / MAC"><input className={inputCls + " font-mono"} placeholder="AA:BB:CC:DD:EE:FF" value={f.bssid} onChange={(e) => setF({ ...f, bssid: e.target.value })} /></Field>
            <Field label="Venue Location"><input className={inputCls} placeholder="e.g. Westlands Mall" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} /></Field>
            <button onClick={add} className="h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground">Add to Pool</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function RelayMonitor() {
  const [log] = useStored<RelayLog>(KEYS.relay, emptyRelay);
  const peers = new Set(log.events.map((e) => e.peer)).size;
  return (
    <Panel title="Mesh Swarm & Relay Activity" icon={<Radio className="h-4 w-4" />}
      action={<span className="text-[10px] uppercase tracking-wider text-muted-foreground">Simulated</span>}>
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-background p-2"><div className="font-mono font-bold">{(log.assistedKb / 1024).toFixed(1)} MB</div><div className="text-[11px] text-muted-foreground">Peer-assist sent</div></div>
        <div className="rounded-lg bg-background p-2"><div className="font-mono font-bold">{(log.receivedKb / 1024).toFixed(1)} MB</div><div className="text-[11px] text-muted-foreground">Reciprocal received</div></div>
        <div className="rounded-lg bg-background p-2"><div className="font-mono font-bold">{peers}</div><div className="text-[11px] text-muted-foreground">Peers seen</div></div>
      </div>
      <Table head={["Time", "Node", "Direction", "Peer", "Via", "Data"]} empty="No relay activity yet — starts automatically when a pass is online."
        rows={log.events.slice(0, 25).map((e) => [
          new Date(e.at).toLocaleTimeString(), `+${e.from}`,
          e.kind === "assist" ? <Pill tone="primary">→ Assist</Pill> : <Pill tone="warning">← Received</Pill>,
          <span className="font-mono text-xs">{e.peer}</span>, e.via, `${e.kb} KB`,
        ])} />
    </Panel>
  );
}
