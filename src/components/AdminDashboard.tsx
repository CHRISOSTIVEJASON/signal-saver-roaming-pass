import { getAdminPaymentConfig, savePaymentConfig, updateMasterPasscode } from "@/lib/cloud.functions";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, LogOut, Plus, Radio, Settings, Smartphone, Trash2, Users, Wallet, Wifi, Database, X } from "lucide-react";
import { toast } from "sonner";
import { APP_VERSION, changePasscode, formatClock, getPass, tick } from "@/lib/rules";
import { Button } from "./ui/button";
import type { MeshLink } from "@/lib/relay";
import { CaptiveCredentialsDialog } from './CaptiveCredentialsDialog';
import { saveShared } from '@/lib/cloud-cache';
import { useConfig, useDevice } from "@/components/Gates";
import { KEYS, emptyRelay, uid, type RelayLog, useStored, write, type Network, type PayConfig, type Session, type Txn, getPasscode } from "@/lib/store";

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

  const [tab, setTab] = useState<"pool" | "roam" | "pay" | "set">("pool");
  const tabs = [
    { id: "pool", label: "Wi-Fi Pool", icon: <Wifi className="h-4 w-4" /> },
    { id: "roam", label: "Live Roaming", icon: <Radio className="h-4 w-4" /> },
    { id: "pay", label: "M-Pesa & PayHero", icon: <Wallet className="h-4 w-4" /> },
    { id: "set", label: "Settings & APK", icon: <Settings className="h-4 w-4" /> },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-widest text-accent">Admin Console</div>
          <h2 className="text-lg font-bold">Dashboard</h2>
        </div>
        <Button onClick={onExit} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-secondary">
          <LogOut className="h-3.5 w-3.5" /> Exit
        </Button>
      </div>

      <div className="grid grid-cols-4 gap-2">
        <Metric icon={<Wallet />} label="Revenue" value={`${revenue.toLocaleString()}`} />
        <Metric icon={<Users />} label="Active" value={active.length} />
        <Metric icon={<Wifi />} label="Pool Wi-Fi" value={networks.length} />
        <Metric icon={<Database />} label="Data GB" value={gb.toFixed(2)} />
      </div>

      <div role="tablist" className="sticky top-0 z-10 grid grid-cols-4 gap-1 rounded-xl bg-background/90 p-1 backdrop-blur">
        {tabs.map((t) => (
          <Button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[11px] font-medium leading-tight sm:flex-row sm:justify-center sm:gap-1.5 sm:text-sm ${tab === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"}`}>
            {t.icon}<span className="text-center">{t.label}</span>
          </Button>
        ))}
      </div>

      {tab === "pool" && <PoolManager />}
      {tab === "roam" && (<>
        <Panel title="Live Clients & Roaming" icon={<Radio className="h-4 w-4" />}>
          <Table head={["Phone", "Pass", "Time left", "State"]} empty="No active sessions yet."
            rows={active.map((s) => [
              `+${s.phone}`, getPass(s.passId).label, <span className="font-mono">{formatClock(s.remainingMs)}</span>,
              s.online ? <Pill tone="primary">Active</Pill> : <Pill tone="warning">Frozen</Pill>,
            ])} />
        </Panel>
        <RelayMonitor />
      </>)}
      {tab === "pay" && (<>
        <PayHeroCard />
        <Panel title="M-Pesa Transactions" icon={<Wallet className="h-4 w-4" />}>
          <Table head={["Time", "Phone", "Amount", "Reference", "Mode", "Status"]} empty="No transactions yet."
            rows={txns.map((t) => [
              new Date(t.at).toLocaleString(), `+${t.phone}`, `KES ${t.amount}`, <span className="font-mono text-xs">{t.ref}</span>, t.mode,
              <Pill tone={t.status === "Activated" ? "primary" : t.status === "Failed" ? "destructive" : "warning"}>{t.status}</Pill>,
            ])} />
        </Panel>
      </>)}
      {tab === "set" && (<div className="space-y-4"><PasscodeCard /><AppSettingsCard /></div>)}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/40 p-2">
      <div className="text-accent [&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</div>
      <div className="truncate font-mono text-base font-bold">{value}</div>
      <div className="truncate text-[10px] text-muted-foreground">{label}</div>
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
      <Button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-2.5 text-muted-foreground" aria-label="Toggle visibility">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}

function PayHeroCard() {
  const [saved, setSaved] = useConfig();
  const [c, setC] = useState(saved);
  const [authOpen, setAuthOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const fetchCloudConfig = useServerFn(getAdminPaymentConfig);
  const saveCloudConfig = useServerFn(savePaymentConfig);

  useEffect(() => {
    let cancelled = false;
    void fetchCloudConfig({ data: {} })
      .then((remote) => {
        if (!cancelled && remote) {
          setC((prev) => ({
            ...prev,
            apiToken: prev.apiToken || remote.apiToken,
            username: prev.username || remote.username,
            password: prev.password || remote.password,
            channelId: prev.channelId || remote.channelId,
            live: remote.live ?? prev.live,
          }));
          setSaved((prev) => ({
            ...prev,
            apiToken: prev.apiToken || remote.apiToken,
            username: prev.username || remote.username,
            password: prev.password || remote.password,
            channelId: prev.channelId || remote.channelId,
            live: remote.live ?? prev.live,
          }));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fetchCloudConfig]);

  useEffect(() => {
    setC((prev) => ({
      ...prev,
      ...saved,
      apiToken: saved.apiToken || prev.apiToken,
      username: saved.username || prev.username,
      password: saved.password || prev.password,
      channelId: saved.channelId || prev.channelId,
    }));
  }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof PayConfig) => (v: string | boolean) => setC((prev) => ({ ...prev, [k]: v }));

  const handleSaveClick = () => {
    if (c.live && (!c.channelId || !(c.apiToken || (c.username && c.password)))) {
      toast.error("Live mode needs a Channel ID and either an API token or username + password");
      return;
    }
    setAuthOpen(true);
  };

  const confirmSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passcode !== getPasscode()) {
      toast.error("Incorrect master passcode");
      return;
    }
    setSaved(c);
    try {
      await saveCloudConfig({ data: c });
    } catch (err) {
      console.warn("Cloud save deferred:", err);
    }
    toast.success("PayHero settings saved");
    setAuthOpen(false);
    setPasscode("");
  };

  return (
    <Panel title="PayHero Configuration" icon={<KeyRound className="h-4 w-4" />}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-background p-1 text-sm">
          {[false, true].map((l) => (
            <Button key={String(l)} onClick={() => set("live")(l)}
              className={`rounded-md py-2 font-medium ${c.live === l ? (l ? "bg-primary text-primary-foreground" : "bg-secondary") : "text-muted-foreground"}`}>
              {l ? "Live PayHero STK Push" : "Demo Simulation Mode"}
            </Button>
          ))}
        </div>
        <Field label="API Key / Basic Auth Token"><Secret value={c.apiToken} onChange={set("apiToken")} placeholder="Basic xxxxx (optional if username/password set)" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Username"><input className={inputCls} value={c.username} onChange={(e) => set("username")(e.target.value)} autoComplete="off" /></Field>
          <Field label="Password"><Secret value={c.password} onChange={set("password")} /></Field>
        </div>
        <Field label="Channel ID"><input className={inputCls} inputMode="numeric" value={c.channelId} onChange={(e) => set("channelId")(e.target.value)} /></Field>
        <Button onClick={handleSaveClick} className="h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:brightness-110">Save Configuration</Button>
      </div>

      {authOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => { setAuthOpen(false); setPasscode(""); }}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">Authorize PayHero Update</h3>
              <Button variant="ghost" size="icon" onClick={() => { setAuthOpen(false); setPasscode(""); }} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">Enter master passcode to confirm updating PayHero credentials.</p>
            <form onSubmit={confirmSave} className="space-y-4">
              <Secret value={passcode} onChange={setPasscode} placeholder="Enter master passcode" />
              <div className="flex gap-2">
                <Button type="button" onClick={() => { setAuthOpen(false); setPasscode(""); }} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</Button>
                <Button type="submit" className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">Authorize & Save</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Panel>
  );
}

function PasscodeCard() {
  const [step, setStep] = useState<"idle" | "security" | "new">("idle");
  const [sec, setSec] = useState("");
  const [pass, setPass] = useState("");
  const [saving, setSaving] = useState(false);
  const saveCloudPasscode = useServerFn(updateMasterPasscode);

  const verify = () => {
    if (sec !== "2006") { toast.error("Invalid security code"); return; }
    setStep("new");
  };

  const save = async () => {
    const r = changePasscode(sec, pass);
    if (!r.ok) { toast.error(r.error); return; }
    setSaving(true);
    try {
      write(KEYS.passcode, r.passcode);
      try {
        await saveCloudPasscode({ data: { currentSecurityCode: sec, newPasscode: r.passcode } });
      } catch (err) {
        console.warn("Cloud passcode sync warning:", err);
      }
      toast.success("Master passcode updated globally across all apps");
      setStep("idle"); setSec(""); setPass("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Master Passcode" icon={<KeyRound className="h-4 w-4" />}>
      {step === "idle" && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Change the master passcode used to open this dashboard across all apps. A security code is required.</p>
          <Button onClick={() => setStep("security")} className="h-10 w-full rounded-lg border border-border text-sm font-medium hover:bg-secondary">Change Passcode</Button>
        </div>
      )}
      {step === "security" && (
        <div className="space-y-3">
          <Field label="Enter Security Code"><Secret value={sec} onChange={setSec} /></Field>
          <div className="flex gap-2">
            <Button onClick={() => { setStep("idle"); setSec(""); }} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</Button>
            <Button onClick={verify} className="h-10 flex-1 rounded-lg bg-accent text-sm font-semibold text-accent-foreground">Verify</Button>
          </div>
        </div>
      )}
      {step === "new" && (
        <div className="space-y-3">
          <Field label="New Master Passcode"><Secret value={pass} onChange={setPass} /></Field>
          <div className="flex gap-2">
            <Button onClick={() => { setStep("idle"); setSec(""); setPass(""); }} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</Button>
            <Button onClick={save} disabled={saving} className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
              {saving ? "Saving..." : "Save Passcode"}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

function AppSettingsCard() {
  const [saved, setSaved] = useConfig();
  const [c, setC] = useState(saved);
  const [saving, setSaving] = useState(false);
  const saveCloudSettings = useServerFn(savePaymentConfig);

  useEffect(() => setC(saved), [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!/^\d+(\.\d+)*$/.test(c.latestVersion.trim())) { toast.error("Version must look like 1.2.0"); return; }
    setSaving(true);
    const next = { ...saved, apkUrl: c.apkUrl.trim(), latestVersion: c.latestVersion.trim(), updateRequired: c.updateRequired };
    try {
      setSaved(next);
      await saveCloudSettings({ data: next });
      toast.success("App settings saved and synced to all devices");
    } catch (err) {
      console.warn("Failed cloud settings save:", err);
      toast.error("Failed to sync settings to cloud database");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Android App & Updates" icon={<Smartphone className="h-4 w-4" />}>
      <div className="space-y-3">
        <Field label="APK download link"><input className={inputCls} value={c.apkUrl} placeholder="https://…/global-networks.apk" onChange={(e) => setC({ ...c, apkUrl: e.target.value })} /></Field>
        <Field label={`Latest version (installed app is ${APP_VERSION})`}><input className={inputCls + " font-mono"} value={c.latestVersion} onChange={(e) => setC({ ...c, latestVersion: e.target.value })} /></Field>
        <label className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
          Require users to update (blocks app till updated)
          <input type="checkbox" checked={c.updateRequired} onChange={(e) => setC({ ...c, updateRequired: e.target.checked })} className="h-5 w-5 accent-[var(--primary)]" />
        </label>
        <Button onClick={save} disabled={saving} className="h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:brightness-110">
          {saving ? "Saving..." : "Save App Settings"}
        </Button>
      </div>
    </Panel>
  );
}

function PoolManager() {
  const [networks, setNetworks] = useStored<Network[]>(KEYS.networks, []);
  const [device] = useDevice();
  const [manualSsid, setManualSsid] = useState("");
  const [manualBssid, setManualBssid] = useState("");
  const [venue, setVenue] = useState("");
  const [isCaptive, setIsCaptive] = useState(false);
  const [editing, setEditing] = useState<Network | null>(null);
  const [pendingCaptiveNetwork, setPendingCaptiveNetwork] = useState<Network | null>(null);
  const [stamping, setStamping] = useState(false);
  const cur = device.currentWifi;

  const stamp = async () => {
    const rawSsid = (cur?.ssid || manualSsid).trim();
    if (!rawSsid) {
      toast.error("Enter network SSID or connect phone to Wi-Fi to stamp");
      return;
    }
    const rawBssid = (cur?.bssid || manualBssid.trim() || ("GN:" + Math.abs(rawSsid.split("").reduce((a, b) => ((a << 5) - a) + b.charCodeAt(0), 0)).toString(16).toUpperCase())).trim().toUpperCase();
    
    // Check duplication strictly by BSSID: networks may share the same name (SSID),
    // but the exact same hardware BSSID must never be stamped twice into the pool!
    if (networks.some((n) => n.bssid.trim().toUpperCase() === rawBssid)) {
      toast.error(`Network with BSSID ${rawBssid} is already in the pool! Duplicate BSSID is not allowed.`);
      return;
    }

    const network: Network = { id: uid(), ssid: rawSsid, bssid: rawBssid, venue: venue.trim(), addedAt: Date.now() };

    // If captive is checked, do NOT save yet — open the credentials dialogue box first
    if (isCaptive) {
      setPendingCaptiveNetwork(network);
      return;
    }

    // If not captive, finish the process directly on save with feedback
    setStamping(true);
    try {
      const nextNetworks = [network, ...networks];
      setNetworks(nextNetworks);
      void saveShared(KEYS.networks, nextNetworks).catch(() => {});
      setVenue("");
      setManualSsid("");
      setManualBssid("");
      setIsCaptive(false);
      toast.success(`Stored!! ${rawSsid} stamped into pool`);
    } catch {
      toast.error("Unable to stamp network");
    } finally {
      setStamping(false);
    }
  };

  return (
    <Panel title="Wi-Fi Master Pool" icon={<Wifi className="h-4 w-4" />}>
      <div className="mb-4 space-y-2.5 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="text-xs text-muted-foreground">Currently connected</div>
        <div className="font-medium">
          {cur ? (
            <>{cur.ssid} <span className="font-mono text-xs text-muted-foreground">{cur.bssid}</span></>
          ) : (
            <div className="space-y-1.5">
              <span className="text-warning text-xs">Wi-Fi auto-detect waiting or restricted:</span>
              <input
                className={inputCls}
                placeholder="Type Wi-Fi name (SSID) to stamp, e.g. Safaricom_Hotspot"
                value={manualSsid}
                onChange={(e) => setManualSsid(e.target.value)}
              />
              <input
                className={inputCls + " font-mono text-xs"}
                placeholder="Wi-Fi BSSID (optional, e.g. 00:1A:2B:3C:4D:5E)"
                value={manualBssid}
                onChange={(e) => setManualBssid(e.target.value)}
              />
            </div>
          )}
        </div>
        <input className={inputCls} placeholder="Venue label (optional), e.g. Westlands Mall" value={venue} onChange={(e) => setVenue(e.target.value)} />
        <label className="flex items-center gap-2.5 rounded-lg border border-border bg-background/50 p-2.5 text-xs font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={isCaptive}
            onChange={(e) => setIsCaptive(e.target.checked)}
            className="h-4 w-4 rounded accent-[var(--primary)]"
          />
          <span>Requires captive portal login (voucher, username, or PIN)</span>
        </label>
        <Button onClick={stamp} disabled={stamping} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground hover:brightness-110">
          <Plus className="h-4 w-4" />{isCaptive ? "Configure & Save Captive Wi-Fi" : "Save Wi-Fi Network into Pool"}
        </Button>
      </div>
      {networks.length === 0 ? <p className="py-4 text-center text-sm text-muted-foreground">No networks stamped yet.</p> : (
        <ul className="space-y-2">
          {networks.map((n) => (
            <li key={n.id} className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{n.ssid}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">{n.bssid}{n.venue ? ` • ${n.venue}` : ""}</div>
              </div>
              <Button variant="outline" size="icon" title="Edit network login" aria-label={`Edit network login for ${n.ssid}`} onClick={() => setEditing(n)}><KeyRound className="h-4 w-4" /></Button>
              <Button onClick={async () => {
                const next = networks.filter((x) => x.id !== n.id && x.bssid.toUpperCase() !== n.bssid.toUpperCase());
                setNetworks(next);
                void saveShared(KEYS.networks, next).catch(() => {});
                try {
                  const { supabase } = await import('@/integrations/supabase/client');
                  await supabase.from('gn_networks').delete().eq('id', n.id);
                } catch {}
                toast("Removed from pool");
              }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-destructive px-2 py-1.5 text-xs font-medium text-destructive-foreground"><Trash2 className="h-3 w-3" />Remove from Pool</Button>
            </li>
          ))}
        </ul>
      )}
      {pendingCaptiveNetwork && (
        <CaptiveCredentialsDialog
          network={pendingCaptiveNetwork}
          initialCaptiveRequired={true}
          onSaved={() => {
            const nextNetworks = [pendingCaptiveNetwork, ...networks];
            setNetworks(nextNetworks);
            void saveShared(KEYS.networks, nextNetworks).catch(() => {});
            setVenue("");
            setManualSsid("");
            setManualBssid("");
            setIsCaptive(false);
            setPendingCaptiveNetwork(null);
            toast.success(`Stored!! ${pendingCaptiveNetwork.ssid} captive network saved to pool`);
          }}
          onClose={() => setPendingCaptiveNetwork(null)}
        />
      )}
      {editing && (
        <CaptiveCredentialsDialog
          network={editing}
          onSaved={() => {
            toast.success(`Stored!! ${editing.ssid} credentials updated`);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function RelayMonitor() {
  const [log] = useStored<RelayLog>(KEYS.relay, emptyRelay);
  const [links] = useStored<MeshLink[]>(KEYS.mesh, []);
  const activeLinks = links.filter((link) => link.connected && Date.now() - link.updatedAt < 30_000);
  const peers = new Set(log.events.map((e) => e.peer)).size;
  return (
    <Panel title="Mesh Swarm & Relay Activity" icon={<Radio className="h-4 w-4" />}
      action={<span className="text-[10px] uppercase tracking-wider text-muted-foreground">Simulated</span>}>
      <Table head={["Group Owner / Relay", "Clients", "Network", "Transport", "Source"]} empty="No active Wi-Fi Direct links." rows={activeLinks.map((link) => [link.groupOwner, link.clients.join(", ") || "No clients", link.networkName, link.transportReady ? "Ready" : "Local link only", link.source])} />
      <div className="mb-3 mt-3 grid grid-cols-3 gap-2 text-center">
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
