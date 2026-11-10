import { getAdminPaymentConfig, savePaymentConfig, getCloudTransactionsAndSessions, updateMasterPasscode, removeCloudNetwork, syncCloudNetworks, toggleServiceStatus, getServiceStatus, getExemptedNumbers, saveExemptedNumbers, getCloudOffers, saveCloudOffers, toggleFreezeSession, resetDeviceLock, getBlockedNumbers, saveBlockedNumbers, wipeUserSession, wipeAllUserSessions } from "@/lib/cloud.functions";
import { Capacitor } from "@capacitor/core";
import { GlobalRelay } from "@/lib/native-relay";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState, type ReactNode } from "react";
import { Eye, EyeOff, KeyRound, LogOut, Plus, Radio, Settings, Smartphone, Trash2, Users, Wallet, Wifi, Database, X, Power, PowerOff, PhoneCall, Tag, Edit2, Ban, Play, Snowflake, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { APP_VERSION, changePasscode, formatClock, getPass, tick, normalizePhone } from "@/lib/rules";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import type { MeshLink } from "@/lib/relay";
import { CaptiveCredentialsDialog } from './CaptiveCredentialsDialog';
import { saveShared } from '@/lib/cloud-cache';
import { useConfig, useDevice } from "@/components/Gates";
import { KEYS, emptyRelay, uid, type RelayLog, useStored, write, read, type Device, defaultDevice, type Network, type PayConfig, type Session, type Txn, getPasscode, useAppVersion, useServiceStatus, useExemptedNumbers, useOffers, type PassOffer, useBlockedNumbers, type BlockedNumber, useNetworkAlerts, resolveNetworkAlert, type NetworkAlert } from "@/lib/store";

const GB_PER_HOUR = 0.35;

export function AdminDashboard({ onExit }: { onExit: () => void }) {
  const [runningVer] = useAppVersion();
  const [localTxns, setLocalTxns] = useStored<Txn[]>(KEYS.txns, []);
  const [localSessions, setLocalSessions] = useStored<Session[]>(KEYS.sessions, []);
  const [cloudTxns, setCloudTxns] = useState<Txn[]>([]);
  const [cloudSessions, setCloudSessions] = useState<Session[]>([]);
  const [activeOnly, setActiveOnly] = useState(true);
  const [networks, setNetworks] = useStored<Network[]>(KEYS.networks, []);
  const [status] = useServiceStatus();
  const [blocked, setBlocked] = useBlockedNumbers();
  const [alerts] = useNetworkAlerts();
  const unresolvedAlerts = alerts.filter((a) => !a.resolved);
  const [settingsDialog, setSettingsDialog] = useState<"service" | "passcode" | "app" | "payhero" | "offers" | "exempted" | "blocked" | "ledger" | "alerts" | null>(null);
  const [now, setNow] = useState(Date.now());
  const fetchCloudRecords = useServerFn(getCloudTransactionsAndSessions);
  const toggleFreeze = useServerFn(toggleFreezeSession);
  const resetLock = useServerFn(resetDeviceLock);
  const wipeSessionFn = useServerFn(wipeUserSession);
  const wipeAllSessionsFn = useServerFn(wipeAllUserSessions);
  const [wipeTarget, setWipeTarget] = useState<Session | null>(null);
  const [wipeAllOpen, setWipeAllOpen] = useState(false);
  const [wiping, setWiping] = useState(false);

  async function handleConfirmWipe() {
    if (!wipeTarget) return;
    setWiping(true);
    try {
      await wipeSessionFn({ data: { sessionId: wipeTarget.id } });
      setCloudSessions((prev) => prev.filter((s) => s.id !== wipeTarget.id));
      setLocalSessions((prev) => prev.filter((s) => s.id !== wipeTarget.id));
      // Clear local storage if target was on this device
      const local = read<Session[]>(KEYS.sessions, []);
      write(KEYS.sessions, local.filter((s) => s.id !== wipeTarget.id && normalizePhone(s.phone) !== normalizePhone(wipeTarget.phone)));
      const active = read<Session | null>(KEYS.active, null);
      if (active && (active.id === wipeTarget.id || normalizePhone(active.phone) === normalizePhone(wipeTarget.phone))) {
        write(KEYS.active, null);
      }
      if (Capacitor.isNativePlatform()) {
        void GlobalRelay.stop().catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.sessions }));
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.active }));
      toast.success(`User +${wipeTarget.phone} wiped out and device reset to factory.`);
      setWipeTarget(null);
    } catch (err: any) {
      toast.error(err?.message || "Failed to wipe user session");
    } finally {
      setWiping(false);
    }
  }

  async function handleConfirmWipeAll() {
    setWiping(true);
    try {
      const res = await wipeAllSessionsFn();
      setCloudSessions([]);
      setLocalSessions([]);
      write(KEYS.sessions, []);
      write(KEYS.active, null);
      if (Capacitor.isNativePlatform()) {
        void GlobalRelay.stop().catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.sessions }));
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.active }));
      toast.success(`Wiped all active users (${res?.count || 0} sessions). All devices reset to factory.`);
      setWipeAllOpen(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to wipe all sessions");
    } finally {
      setWiping(false);
    }
  }

  async function handleResetLock(sessionId: string, lockType: "companion" | "all") {
    const label = lockType === "companion" ? "release the companion slot" : "reset all device locks (primary & companion)";
    if (confirm(`Reset device lock for this pass? This will ${label} so the customer can re-bind if cache was cleared or phone replaced.`)) {
      try {
        await resetLock({ data: { sessionId, lockType } });
        setCloudSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, pairedCompanionId: null } : s))
        );
        toast.success(`Device lock reset (${lockType}). Devices can now re-bind.`);
      } catch (err: any) {
        toast.error(err?.message || "Failed to reset device lock");
      }
    }
  }
  const saveBlockedList = useServerFn(saveBlockedNumbers);
  const fetchBlocked = useServerFn(getBlockedNumbers);

  useEffect(() => {
    fetchBlocked().then((res) => {
      if (Array.isArray(res)) setBlocked(res);
    }).catch(() => {});
  }, [fetchBlocked, setBlocked]);

  async function handleToggleFreeze(sessionId: string, freeze: boolean) {
    try {
      await toggleFreeze({ data: { sessionId, frozen: freeze } });
      setCloudSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, frozen: freeze, online: freeze ? false : s.online } : s))
      );
      setLocalSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, frozen: freeze, online: freeze ? false : s.online } : s))
      );
      // Synchronize local storage immediately
      const localSess = read<Session[]>(KEYS.sessions, []);
      const updatedLocalSess = localSess.map((s) => (s.id === sessionId ? { ...s, frozen: freeze, online: freeze ? false : s.online } : s));
      write(KEYS.sessions, updatedLocalSess);
      const activeSess = read<Session | null>(KEYS.active, null);
      if (activeSess && activeSess.id === sessionId) {
        write(KEYS.active, { ...activeSess, frozen: freeze, online: freeze ? false : activeSess.online });
      }
      if (freeze && Capacitor.isNativePlatform()) {
        void GlobalRelay.stop().catch(() => {});
      }
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.sessions }));
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.active }));
      toast.success(freeze ? "❄️ Pass frozen! Internet access cut immediately." : "✅ Pass unfrozen! Access resumed.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to update freeze state");
    }
  }

  async function handleQuickBlock(phone: string) {
    const norm = normalizePhone(phone);
    if (!norm) return;
    if (confirm(`Block +${norm} from accessing services and buying passes? This will also freeze active passes.`)) {
      try {
        const updated = [...blocked.filter((b: BlockedNumber) => normalizePhone(b.phone) !== norm), { phone: norm, reason: "Blocked from live roaming", addedAt: Date.now() }];
        await saveBlockedList({ data: { numbers: updated } });
        setBlocked(updated);
        write(KEYS.blockedNumbers, updated);
        setCloudSessions((prev) =>
          prev.map((s) => (normalizePhone(s.phone) === norm ? { ...s, frozen: true, online: false } : s))
        );
        toast.success(`+${norm} blocked and active pass frozen.`);
      } catch (err: any) {
        toast.error(err?.message || "Failed to block user");
      }
    }
  }



  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const res = await fetchCloudRecords({ data: {} });
        if (!cancelled && res) {
          if (res.txns?.length) {
            setCloudTxns(res.txns);
            setLocalTxns((prev) => {
              const ids = new Set(res.txns.map((t) => t.id));
              const extra = prev.filter((p) => !ids.has(p.id));
              return [...res.txns, ...extra];
            });
          }
          if (res.sessions?.length) {
            setCloudSessions(res.sessions);
            setLocalSessions((prev) => {
              const ids = new Set(res.sessions.map((s) => s.id));
              const extra = prev.filter((p) => !ids.has(p.id));
              return [...res.sessions, ...extra];
            });
          }
        }
      } catch (err) {
        console.warn("Cloud records sync failed:", err);
      }
    };
    void sync();
    const interval = setInterval(() => { void sync(); }, 4000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [fetchCloudRecords, setLocalTxns, setLocalSessions]);

  const txns = cloudTxns.length ? cloudTxns : localTxns;
  const sessions = cloudSessions.length ? cloudSessions : localSessions;

  const live = sessions.map((s) => ({ ...s, remainingMs: tick(s.remainingMs, s.lastTick, now, s.online) }));
  const active = live.filter((s) => s.remainingMs > 0);
  const revenue = txns.filter((t) => t.status === "Activated").reduce((a, t) => a + t.amount, 0);
  const gb = live.reduce((a, s) => a + ((s.totalMs - s.remainingMs) / 3600_000) * GB_PER_HOUR, 0);

  const isTxnActive = (t: Txn) => {
    if (t.status !== "Activated") return false;
    const durationMs = (getPass(t.passId)?.hours ?? 24) * 3600_000;
    return now <= t.at + durationMs;
  };
  const displayTxns = activeOnly ? txns.filter(isTxnActive) : txns;

  const [tab, setTab] = useState<"pool" | "roam" | "pay" | "set">("set");
  useEffect(() => {
    if (tab !== "roam") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tab]);
  const tabs = [
    { id: "pool", label: "Wi-Fi Pool", icon: <Wifi className="h-4 w-4" /> },
    { id: "roam", label: "Live Roaming", icon: <Radio className="h-4 w-4" /> },
    { id: "pay", label: "M-Pesa & FinoQ", icon: <Wallet className="h-4 w-4" /> },
    { id: "set", label: "Settings & APK", icon: <Settings className="h-4 w-4" /> },
  ] as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-widest text-accent">Admin Console</span>
            <span className="font-mono text-xs rounded bg-accent/20 px-1.5 py-0.5 text-accent font-semibold">v{runningVer}</span>
          </div>
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

      {unresolvedAlerts.length > 0 && (
        <button
          type="button"
          onClick={() => setSettingsDialog("alerts")}
          className="flex w-full items-center justify-between gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive transition hover:bg-destructive/15 text-left"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-destructive animate-pulse" />
            <span>
              <strong>{unresolvedAlerts.length} Network Alert{unresolvedAlerts.length > 1 ? "s" : ""}:</strong> WPA2 password mismatch on router ({unresolvedAlerts.map((a) => a.ssid).join(", ")})
            </span>
          </div>
          <span className="font-semibold underline shrink-0">Review Alert</span>
        </button>
      )}

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
        <Panel
          title="Live Clients & Roaming"
          icon={<Radio className="h-4 w-4" />}
          action={
            active.length > 0 ? (
              <Button
                size="sm"
                variant="destructive"
                className="h-7 px-2.5 text-xs font-semibold gap-1 bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm"
                onClick={() => setWipeAllOpen(true)}
              >
                <Trash2 className="h-3 w-3" />
                Wipe All Current Users
              </Button>
            ) : undefined
          }
        >
          <Table head={["Phone", "Pass", "Time left", "State", "Actions"]} empty="No active sessions yet."
            rows={active.map((s) => [
              `+${s.phone}`, getPass(s.passId).label, <span className="font-mono">{formatClock(s.remainingMs)}</span>,
              s.frozen ? <Pill tone="destructive">Frozen by Admin</Pill> : s.online ? <Pill tone="primary">Active</Pill> : <Pill tone="warning">Searching</Pill>,
              <div className="flex items-center gap-1.5" key={s.id}>
                {s.frozen ? (
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-primary border-primary/40 hover:bg-primary/10" onClick={() => handleToggleFreeze(s.id, false)}>
                    <Play className="mr-1 h-3 w-3" /> Unfreeze
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-warning border-warning/40 hover:bg-warning/10" onClick={() => handleToggleFreeze(s.id, true)}>
                    <Snowflake className="mr-1 h-3 w-3" /> Freeze
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" title="Reset device lock if cache was cleared" onClick={() => handleResetLock(s.id, "all")}>
                  <KeyRound className="mr-1 h-3 w-3" /> Unlock
                </Button>
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10" onClick={() => handleQuickBlock(s.phone)}>
                  <Ban className="mr-1 h-3 w-3" /> Block
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-7 px-2 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  title="Wipe out user and factory reset their phone"
                  onClick={() => setWipeTarget(s)}
                >
                  <Trash2 className="mr-1 h-3 w-3" /> Wipe Out
                </Button>
              </div>,
            ])} />
        </Panel>
        <RelayMonitor />
      </>)}
      {tab === "pay" && (
        <div className="space-y-3">
          <p className="px-1 text-xs text-muted-foreground">Choose an action to open its focused settings dialog.</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <AdminAction icon={<Wallet className="h-5 w-5" />} label="FinoQ / M-Pesa" detail="Gateway and payment mode" onClick={() => setSettingsDialog("payhero")} />
            <AdminAction icon={<Tag className="h-5 w-5" />} label="Pass Packages" detail="Pricing and durations" onClick={() => setSettingsDialog("offers")} />
            <AdminAction icon={<PhoneCall className="h-5 w-5" />} label="VIP Exemptions" detail="Free-access phone list" onClick={() => setSettingsDialog("exempted")} />
            <AdminAction icon={<Ban className="h-5 w-5" />} label="Blocked Users" detail={`${blocked.length} numbers blocked`} onClick={() => setSettingsDialog("blocked")} tone={blocked.length > 0 ? "danger" : "default"} />
            <AdminAction icon={<Database className="h-5 w-5" />} label="Transaction Ledger" detail={`${displayTxns.length} records`} onClick={() => setSettingsDialog("ledger")} />
          </div>
        </div>
      )}
      {tab === "set" && (
        <div className="space-y-3">
          <p className="px-1 text-xs text-muted-foreground">Tap an action to open its focused settings dialog.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <AdminAction icon={status.active ? <Power className="h-5 w-5" /> : <PowerOff className="h-5 w-5" />} label="Master Service Switch" detail={status.active ? "Currently online" : "Currently closed"} onClick={() => setSettingsDialog("service")} tone={!status.active ? "danger" : "default"} />
            <AdminAction icon={<KeyRound className="h-5 w-5" />} label="Change Passcode" detail="Admin access security" onClick={() => setSettingsDialog("passcode")} />
            <AdminAction icon={<Smartphone className="h-5 w-5" />} label="App Updates / APK" detail={`Installed v${runningVer}`} onClick={() => setSettingsDialog("app")} />
            <AdminAction icon={<ShieldAlert className="h-5 w-5" />} label="Network Alerts" detail={unresolvedAlerts.length > 0 ? `${unresolvedAlerts.length} router alerts` : "All networks normal"} onClick={() => setSettingsDialog("alerts")} tone={unresolvedAlerts.length > 0 ? "danger" : "default"} />
          </div>
        </div>
      )}

      <Dialog open={settingsDialog === "alerts"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-destructive" />
              Network Authentication Alerts
            </DialogTitle>
            <DialogDescription>
              One-time alerts triggered by devices when a stamped WPA2 network's password changes on the router.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {unresolvedAlerts.length === 0 ? (
              <div className="rounded-xl border border-border bg-secondary/20 p-6 text-center">
                <ShieldCheck className="mx-auto h-8 w-8 text-primary/70 mb-2" />
                <p className="text-sm font-semibold">No Active Network Alerts</p>
                <p className="text-xs text-muted-foreground mt-1">
                  All stamped WPA2 networks are authenticating normally. If any router password changes, a one-time alert will appear here.
                </p>
              </div>
            ) : (
              unresolvedAlerts.map((alert) => (
                <div key={alert.id} className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{alert.ssid}</span>
                        <span className="rounded bg-destructive/15 px-2 py-0.5 text-[10px] font-medium text-destructive">
                          Password Changed
                        </span>
                      </div>
                      {alert.venue && <p className="text-xs text-muted-foreground mt-0.5">Venue: {alert.venue}</p>}
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Detected: {new Date(alert.detectedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="rounded-lg bg-background/80 p-2.5 text-xs text-muted-foreground">
                    The router rejected the stored WPA2 password. Update the password below so devices can reconnect automatically.
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        resolveNetworkAlert(alert.id);
                        toast.success(`Alert for ${alert.ssid} dismissed`);
                      }}
                      className="h-8 text-xs"
                    >
                      Dismiss
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        const newPass = window.prompt(`Enter new WPA2 password for ${alert.ssid}:`);
                        if (newPass !== null && newPass.trim()) {
                          const updatedNets = networks.map((n) =>
                            n.ssid.trim().toLowerCase() === alert.ssid.trim().toLowerCase()
                              ? { ...n, password: newPass.trim() }
                              : n
                          );
                          setNetworks(updatedNets);
                          void saveShared(KEYS.networks, updatedNets).catch(() => {});
                          resolveNetworkAlert(alert.id);
                          toast.success(`Password for ${alert.ssid} updated and alert resolved!`);
                        }
                      }}
                      className="h-8 bg-primary text-xs font-semibold text-primary-foreground"
                    >
                      Update Password
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="outline" size="sm" onClick={() => setSettingsDialog(null)} className="h-9 text-xs" type="button">
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsDialog === "service"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>Master Service Switch</DialogTitle><DialogDescription>Pause or resume service for all users.</DialogDescription></DialogHeader>
          <ServiceSwitchCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "passcode"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
          <DialogHeader><DialogTitle>Admin Master Passcode</DialogTitle><DialogDescription>Change the passcode used to access admin controls.</DialogDescription></DialogHeader>
          <PasscodeCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "app"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>App Version & Updates</DialogTitle><DialogDescription>Set the APK download link and mandatory update policy.</DialogDescription></DialogHeader>
          <AppSettingsCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "payhero"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>FinoQ / M-Pesa</DialogTitle><DialogDescription>Configure payment mode and gateway credentials.</DialogDescription></DialogHeader>
          <PayHeroCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "offers"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>Pass Packages & Pricing</DialogTitle><DialogDescription>Manage customer pass offers.</DialogDescription></DialogHeader>
          <OffersCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "exempted"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>VIP Exemptions</DialogTitle><DialogDescription>Manage phone numbers that receive free access.</DialogDescription></DialogHeader>
          <ExemptedNumbersCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "blocked"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>Blocked Phone Numbers</DialogTitle><DialogDescription>Manage phone numbers blocked from purchasing passes or using services.</DialogDescription></DialogHeader>
          <BlockedNumbersCard />
        </DialogContent>
      </Dialog>
      <Dialog open={settingsDialog === "ledger"} onOpenChange={(open) => !open && setSettingsDialog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader><DialogTitle>M-Pesa Transactions</DialogTitle><DialogDescription>Payment activity and pass status.</DialogDescription></DialogHeader>
          <Panel title="Transaction History" icon={<Wallet className="h-4 w-4" />} action={
            <Button type="button" variant={activeOnly ? "default" : "outline"} className="h-7 px-2.5 text-xs" onClick={() => setActiveOnly((p) => !p)}>
              {activeOnly ? "Active Passes" : "All History"}
            </Button>
          }>
            <Table head={["Time", "Phone", "Amount", "Reference", "Mode", "Status"]} empty={activeOnly ? "No active pass payments currently." : "No transactions yet."}
              rows={displayTxns.map((t) => [new Date(t.at).toLocaleString(), `+${t.phone}`, `KES ${t.amount}`, <span className="font-mono text-xs">{t.ref}</span>, t.mode,
                <Pill tone={t.status === "Activated" ? "primary" : t.status === "Failed" ? "destructive" : "warning"}>{t.status}</Pill>])} />
          </Panel>
        </DialogContent>
      </Dialog>

      {/* Extra Confirmation Step: Wipe Single User Dialog */}
      <Dialog open={Boolean(wipeTarget)} onOpenChange={(open) => !open && !wiping && setWipeTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Wipe Out User & Factory Reset?
            </DialogTitle>
            <DialogDescription className="text-left pt-2 text-xs">
              Are you sure you want to completely wipe out this user? This will instantly terminate their active pass even if their countdown timer is still on.
            </DialogDescription>
          </DialogHeader>

          {wipeTarget && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Phone Number:</span>
                <span className="font-mono font-bold text-foreground">+{wipeTarget.phone}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time Remaining:</span>
                <span className="font-mono font-semibold text-warning">{formatClock(wipeTarget.remainingMs)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Package:</span>
                <span className="font-medium text-foreground">{getPass(wipeTarget.passId).label}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Bound Device ID:</span>
                <span className="font-mono text-[11px] text-muted-foreground truncate max-w-[180px]">{wipeTarget.boundDeviceId || "Auto / Local"}</span>
              </div>
            </div>
          )}

          <div className="space-y-1 rounded bg-secondary/60 p-2.5 text-[11px] text-muted-foreground">
            <p className="font-semibold text-foreground">Action Summary:</p>
            <p>• Countdown is terminated and wiped to 00:00.</p>
            <p>• Phone device ID, MAC bindings, and companion links are erased.</p>
            <p>• Active pass record is deleted and cannot be auto-restored.</p>
            <p>• Connected phone immediately returns to the factory purchase screen.</p>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={wiping} onClick={() => setWipeTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={wiping}
              onClick={handleConfirmWipe}
            >
              {wiping ? "Wiping..." : "Confirm Wipe Out (Factory Reset)"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Extra Confirmation Step: Emergency Wipe ALL Users Dialog */}
      <Dialog open={wipeAllOpen} onOpenChange={(open) => !open && !wiping && setWipeAllOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              Emergency Factory Reset: Wipe ALL Users?
            </DialogTitle>
            <DialogDescription className="text-left pt-2 text-xs">
              This will immediately wipe out <strong>ALL {active.length} active users</strong> simultaneously, regardless of how much time remains on their passes.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs space-y-2">
            <p className="text-destructive font-semibold">⚠️ High Impact Operation</p>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              Every connected customer phone will have its active countdown terminated, device bindings wiped, and be returned to the initial factory setup screen. All remaining paid hours will be erased.
            </p>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={wiping} onClick={() => setWipeAllOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={wiping}
              onClick={handleConfirmWipeAll}
            >
              {wiping ? "Wiping All Users..." : "Yes, Wipe All Active Users"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdminAction({ icon, label, detail, onClick, tone = "default" }: { icon: ReactNode; label: string; detail: string; onClick: () => void; tone?: "default" | "danger" }) {
  return (
    <button type="button" onClick={onClick} className={`flex min-h-28 flex-col items-start justify-between rounded-xl border p-3 text-left transition-colors hover:border-primary/50 hover:bg-secondary/40 ${tone === "danger" ? "border-destructive/40 bg-destructive/5" : "border-border bg-card/70"}`}>
      <span className={`rounded-lg p-2 ${tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}>{icon}</span>
      <span className="mt-2 block">
        <span className="block text-xs font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-[10px] text-muted-foreground">{detail}</span>
      </span>
    </button>
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
    <>
      {/* Mobile view: Stacked responsive cards with zero horizontal scroll */}
      <div className="space-y-2.5 sm:hidden">
        {rows.map((row, i) => (
          <div key={i} className="rounded-lg border border-border bg-card/60 p-3 space-y-1.5 text-xs shadow-xs">
            {row.map((cell, j) => (
              <div key={j} className="flex items-center justify-between gap-2 border-b border-border/40 pb-1.5 last:border-b-0 last:pb-0">
                <span className="font-medium text-muted-foreground">{head[j] || ""}:</span>
                <div className="text-right min-w-0 max-w-[70%] break-words">{cell}</div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Desktop/Tablet view: full table */}
      <div className="hidden sm:block -mx-4 overflow-x-auto px-4">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase text-muted-foreground">{head.map((h) => <th key={h} className="pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border">{r.map((c, j) => <td key={j} className="py-2 pr-3">{c}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </>
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


function ServiceSwitchCard() {
  const [status, setStatus] = useServiceStatus();
  const [resumeDate, setResumeDate] = useState(status.resumeDate || "");
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const toggleStatus = useServerFn(toggleServiceStatus);

  useEffect(() => {
    setResumeDate(status.resumeDate || "");
  }, [status.resumeDate]);

  const handleToggle = async (newActive: boolean) => {
    if (!passcode.trim()) {
      toast.error("Master passcode is required to turn services ON or OFF");
      return;
    }
    setBusy(true);
    try {
      const res = await toggleStatus({
        data: {
          passcode: passcode.trim(),
          active: newActive,
          resumeDate: resumeDate.trim(),
        },
      });
      if (res?.ok) {
        setStatus({ active: newActive, resumeDate: resumeDate.trim() });
        write(KEYS.serviceStatus, { active: newActive, resumeDate: resumeDate.trim() });
        setPasscode("");
        toast.success(
          newActive
            ? "Services are now ONLINE across all devices."
            : "SERVICES CLOSED. All customer apps will now show the closure notice."
        );
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to update service status");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdateDate = async () => {
    if (!passcode.trim()) {
      toast.error("Master passcode is required to update resumption date");
      return;
    }
    setBusy(true);
    try {
      const res = await toggleStatus({
        data: {
          passcode: passcode.trim(),
          active: status.active,
          resumeDate: resumeDate.trim(),
        },
      });
      if (res?.ok) {
        setStatus({ active: status.active, resumeDate: resumeDate.trim() });
        write(KEYS.serviceStatus, { active: status.active, resumeDate: resumeDate.trim() });
        setPasscode("");
        toast.success("Resumption date updated globally.");
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to update resumption date");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Master Service Switch (Global App Kill Switch)"
      icon={status.active ? <Power className="h-4 w-4 text-primary" /> : <PowerOff className="h-4 w-4 text-destructive" />}
    >
      <div className="space-y-4">
        <div
          className={`flex items-center justify-between rounded-xl border p-4 ${
            status.active
              ? "border-primary/40 bg-primary/10"
              : "border-destructive/40 bg-destructive/10"
          }`}
        >
          <div>
            <div className="text-xs uppercase font-bold tracking-wider text-muted-foreground">
              Global Service Status
            </div>
            <div className={`text-base font-extrabold flex items-center gap-2 mt-0.5 ${status.active ? "text-primary" : "text-destructive"}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${status.active ? "bg-primary animate-pulse" : "bg-destructive animate-ping"}`} />
              <span>{status.active ? "SERVICES ONLINE (ACTIVE)" : "SERVICES CLOSED (OFFLINE)"}</span>
            </div>
            {!status.active && status.resumeDate && (
              <div className="text-xs text-muted-foreground mt-1">
                Resumes on: <span className="font-semibold text-foreground">{status.resumeDate}</span>
              </div>
            )}
          </div>
          <Pill tone={status.active ? "primary" : "destructive"}>
            {status.active ? "Active" : "Closed"}
          </Pill>
        </div>

        <Field label="Expected Resumption Date / Notice (displayed on all phones when closed)">
          <input
            className={inputCls}
            placeholder="e.g. November 15, 2026 at 08:00 AM"
            value={resumeDate}
            onChange={(e) => setResumeDate(e.target.value)}
          />
        </Field>

        <Field label="Confirm Master Passcode (Required to toggle)">
          <input
            type="password"
            className={inputCls}
            placeholder="Enter master passcode"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
        </Field>

        <div className="flex flex-col sm:flex-row gap-2">
          {status.active ? (
            <Button
              type="button"
              onClick={() => handleToggle(false)}
              disabled={busy}
              className="flex-1 h-10 bg-destructive hover:bg-destructive/90 text-destructive-foreground font-bold text-sm"
            >
              {busy ? "Updating..." : "Turn Services OFF (Close App)"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => handleToggle(true)}
              disabled={busy}
              className="flex-1 h-10 bg-primary hover:bg-primary/90 text-primary-foreground font-bold text-sm"
            >
              {busy ? "Updating..." : "Turn Services ON (Resume Operations)"}
            </Button>
          )}

          {!status.active && (
            <Button
              type="button"
              variant="outline"
              onClick={handleUpdateDate}
              disabled={busy}
              className="h-10 text-xs sm:text-sm"
            >
              Update Resume Date
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}

function ExemptedNumbersCard() {
  const [exempted, setExempted] = useExemptedNumbers();
  const [phoneInput, setPhoneInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [saving, setSaving] = useState(false);
  const saveExemptList = useServerFn(saveExemptedNumbers);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizePhone(phoneInput);
    if (!normalized) {
      toast.error("Enter a valid Safaricom number (07… or 01…)");
      return;
    }
    if (exempted.some((ex) => normalizePhone(ex.phone) === normalized)) {
      toast.error("This phone number is already exempted");
      return;
    }
    const updated = [
      { phone: normalized, note: noteInput.trim() || "VIP / Staff", addedAt: Date.now() },
      ...exempted,
    ];
    setSaving(true);
    try {
      await saveExemptList({ data: { numbers: updated } });
      setExempted(updated);
      write(KEYS.exemptedNumbers, updated);
      setPhoneInput("");
      setNoteInput("");
      toast.success(`+${normalized} added to exempted list! (Pays KES 0)`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save exempted number to cloud");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (phone: string) => {
    const updated = exempted.filter((ex) => ex.phone !== phone);
    setSaving(true);
    try {
      await saveExemptList({ data: { numbers: updated } });
      setExempted(updated);
      write(KEYS.exemptedNumbers, updated);
      toast.success(`Removed +${phone} from exemption`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to update exemption list");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Exempted Phone Numbers (Free VIP Access)" icon={<PhoneCall className="h-4 w-4" />}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Numbers added here bypass M-Pesa payments entirely. When they tap Pay for any package, the prompt is skipped, access is granted immediately, and revenue records KES 0.
        </p>

        <form onSubmit={handleAdd} className="space-y-3 rounded-xl border border-border bg-secondary/20 p-3">
          <div className="text-xs font-semibold uppercase tracking-wider text-foreground">
            Exempt a New Number
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              className={inputCls}
              placeholder="Phone (e.g. 0712345678)"
              value={phoneInput}
              onChange={(e) => setPhoneInput(e.target.value)}
            />
            <input
              className={inputCls}
              placeholder="Label/Note (e.g. Staff, VIP, Field Officer)"
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            disabled={saving}
            className="w-full h-9 bg-primary text-xs font-bold text-primary-foreground hover:brightness-110"
          >
            {saving ? "Saving..." : "Exempt Number (Grant Free Access)"}
          </Button>
        </form>

        <Table
          head={["Phone", "Note", "Added Date", "Action"]}
          empty="No numbers currently exempted. All users pay normal package rates."
          rows={exempted.map((item) => [
            <span className="font-mono font-bold text-primary" key={item.phone}>+{item.phone}</span>,
            <span key={item.phone + "-note"}>{item.note || "VIP"}</span>,
            <span className="text-xs text-muted-foreground" key={item.phone + "-date"}>{new Date(item.addedAt).toLocaleDateString()}</span>,
            <Button
              key={item.phone + "-btn"}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => handleRemove(item.phone)}
              disabled={saving}
              className="h-7 text-xs text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Remove
            </Button>,
          ])}
        />
      </div>
    </Panel>
  );
}

function OffersCard() {
  const [offers, setOffers] = useOffers();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [hours, setHours] = useState("");
  const [amount, setAmount] = useState("");
  const [popular, setPopular] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveOffersCloud = useServerFn(saveCloudOffers);

  const startEdit = (o: PassOffer) => {
    setEditingId(o.id);
    setLabel(o.label);
    setHours(String(o.hours));
    setAmount(String(o.amount));
    setPopular(Boolean(o.popular));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setLabel("");
    setHours("");
    setAmount("");
    setPopular(false);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const h = parseFloat(hours);
    const amt = parseFloat(amount);
    if (!label.trim()) { toast.error("Enter offer label"); return; }
    if (isNaN(h) || h <= 0) { toast.error("Enter valid hours"); return; }
    if (isNaN(amt) || amt < 0) { toast.error("Enter valid price in KES"); return; }

    let updated: PassOffer[];
    if (editingId) {
      updated = offers.map((o) =>
        o.id === editingId
          ? { ...o, label: label.trim(), hours: h, amount: amt, popular }
          : (popular ? { ...o, popular: false } : o)
      );
    } else {
      const newId = "p" + Math.round(h) + "_" + uid().slice(0, 4).toLowerCase();
      const existing = popular ? offers.map((o) => ({ ...o, popular: false })) : offers;
      updated = [...existing, { id: newId, label: label.trim(), hours: h, amount: amt, popular }];
    }

    setSaving(true);
    try {
      await saveOffersCloud({ data: { offers: updated } });
      setOffers(updated);
      write(KEYS.offers, updated);
      cancelEdit();
      toast.success("Offers updated and synced across all customer phones!");
    } catch (err: any) {
      toast.error(err?.message || "Failed to save offers to cloud");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (offers.length <= 1) {
      toast.error("You must keep at least one active offer for users to select.");
      return;
    }
    const updated = offers.filter((o) => o.id !== id);
    setSaving(true);
    try {
      await saveOffersCloud({ data: { offers: updated } });
      setOffers(updated);
      write(KEYS.offers, updated);
      toast.success("Offer removed.");
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete offer");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Pricing & Roaming Offers Manager" icon={<Tag className="h-4 w-4" />}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground leading-relaxed">
          Edit existing packages, adjust prices in KES, change pool hours, or add new offers. Changes sync simultaneously to all customer phones.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {offers.map((o) => (
            <div
              key={o.id}
              className={`rounded-xl border p-3.5 relative flex flex-col justify-between ${
                o.popular ? "border-primary/50 bg-primary/5" : "border-border bg-card"
              }`}
            >
              {o.popular && (
                <span className="absolute -top-2.5 right-3 bg-primary text-primary-foreground font-bold text-[9px] uppercase px-2 py-0.5 rounded-full shadow-sm">
                  Popular
                </span>
              )}
              <div>
                <div className="font-bold text-foreground text-sm">{o.label}</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-xl font-extrabold text-primary font-mono">KES {o.amount}</span>
                  <span className="text-xs text-muted-foreground">({o.hours} Hours access)</span>
                </div>
              </div>
              <div className="mt-3 flex items-center justify-end gap-1.5 pt-2 border-t border-border/50">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => startEdit(o)}
                  className="h-7 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Edit2 className="h-3.5 w-3.5 mr-1" />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(o.id)}
                  disabled={saving}
                  className="h-7 text-xs text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={handleSave} className="space-y-3 rounded-xl border border-border bg-secondary/20 p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground">
              {editingId ? "Edit Offer" : "Add New Offer / Package"}
            </span>
            {editingId && (
              <Button type="button" variant="ghost" size="sm" onClick={cancelEdit} className="h-6 text-xs text-muted-foreground">
                Cancel Edit
              </Button>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Field label="Label">
              <input
                className={inputCls}
                placeholder="e.g. 15 Hours Access"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <Field label="Duration (Hours)">
              <input
                type="number"
                step="any"
                className={inputCls}
                placeholder="e.g. 15"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
              />
            </Field>
            <Field label="Price (KES)">
              <input
                type="number"
                className={inputCls}
                placeholder="e.g. 10"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={popular}
              onChange={(e) => setPopular(e.target.checked)}
              className="h-4 w-4 rounded accent-primary"
            />
            <span>Mark as "Popular / Best Value" banner</span>
          </label>
          <Button
            type="submit"
            disabled={saving}
            className="w-full h-9 bg-primary text-xs font-bold text-primary-foreground hover:brightness-110"
          >
            {saving ? "Saving..." : editingId ? "Update Offer" : "Add Offer"}
          </Button>
        </form>
      </div>
    </Panel>
  );
}

function PayHeroCard() {
  const [saved, setSaved] = useConfig();
  const [c, setC] = useState(saved);
  const [settlementMode, setSettlementMode] = useState<"network" | "channel">(() => {
    return (!saved.channelId || saved.channelId.trim() === "" || saved.channelId.trim() === "63902")
      ? "network"
      : "channel";
  });
  const [authOpen, setAuthOpen] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [saving, setSaving] = useState(false);
  const fetchCloudConfig = useServerFn(getAdminPaymentConfig);
  const saveCloudConfig = useServerFn(savePaymentConfig);

  useEffect(() => {
    let cancelled = false;
    void fetchCloudConfig({ data: {} })
      .then((remote) => {
        if (!cancelled && remote) {
          const isNetwork = !remote.channelId || remote.channelId.trim() === "" || remote.channelId.trim() === "63902";
          setSettlementMode(isNetwork ? "network" : "channel");
          setC((prev) => ({
            ...prev,
            apiToken: prev.apiToken || remote.apiToken,
            username: prev.username || remote.username,
            password: prev.password || remote.password,
            channelId: isNetwork ? "63902" : (remote.channelId || prev.channelId),
            live: remote.live !== undefined ? Boolean(remote.live) : prev.live,
          }));
          setSaved((prev) => ({
            ...prev,
            apiToken: prev.apiToken || remote.apiToken,
            username: prev.username || remote.username,
            password: prev.password || remote.password,
            channelId: isNetwork ? "63902" : (remote.channelId || prev.channelId),
            live: remote.live !== undefined ? Boolean(remote.live) : prev.live,
          }));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [fetchCloudConfig]);

  const set = (k: keyof PayConfig) => (v: string | boolean) => setC((prev) => ({ ...prev, [k]: v }));

  const handleSaveClick = () => {
    if (c.live && !(c.apiToken || (c.username && c.password))) {
      toast.error("Live mode requires an API Token or username + password");
      return;
    }
    setAuthOpen(true);
  };

  const confirmSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (passcode.trim() !== "2006") {
      toast.error("Incorrect security code. Authorization denied.");
      return;
    }
    setSaving(true);
    try {
      const configToSave: PayConfig = {
        ...c,
        channelId: settlementMode === "network" ? "" : (c.channelId === "63902" ? "" : c.channelId.trim()),
      };
      setSaved(configToSave);
      await saveCloudConfig({ data: configToSave });
      toast.success(c.live ? "Live FinoQ STK Push saved & activated!" : "Demo mode saved");
      setAuthOpen(false);
      setPasscode("");
    } catch (err) {
      console.warn("Cloud save error:", err);
      toast.error(err instanceof Error ? err.message : "Failed to save to cloud");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="FinoQ M-Pesa Configuration" icon={<Wallet className="h-4 w-4" />}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1 text-sm">
          <Button
            type="button"
            variant={!c.live ? "default" : "ghost"}
            onClick={() => set("live")(false)}
            className="rounded-md py-2 font-medium"
          >
            Demo Simulation Mode
          </Button>
          <Button
            type="button"
            variant={c.live ? "default" : "ghost"}
            onClick={() => set("live")(true)}
            className="rounded-md py-2 font-medium"
          >
            Live FinoQ STK Push
          </Button>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Settlement Destination
            </label>
            <div className="grid grid-cols-2 gap-1 rounded-lg border border-border bg-background p-1 text-xs">
              <Button
                type="button"
                variant={settlementMode === "network" ? "default" : "ghost"}
                onClick={() => {
                  setSettlementMode("network");
                  set("channelId")("63902");
                }}
                className="rounded-md py-1.5 text-xs font-medium"
              >
                Network Code (Wallet)
              </Button>
              <Button
                type="button"
                variant={settlementMode === "channel" ? "default" : "ghost"}
                onClick={() => {
                  setSettlementMode("channel");
                  if (c.channelId === "63902") {
                    set("channelId")("");
                  }
                }}
                className="rounded-md py-1.5 text-xs font-medium"
              >
                Channel ID (External)
              </Button>
            </div>
          </div>

          {settlementMode === "network" ? (
            <Field label="Network Code (FinoQ Wallet Collection)">
              <input
                className={inputCls + " font-mono font-semibold text-primary"}
                value={c.channelId || "63902"}
                placeholder="63902"
                onChange={(e) => set("channelId")(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Autofilled for Safaricom M-Pesa (<strong>63902</strong>). Funds settle directly into your FinoQ wallet.
              </p>
            </Field>
          ) : (
            <Field label="Channel ID (Till / Paybill / Bank)">
              <input
                className={inputCls + " font-mono"}
                value={c.channelId === "63902" ? "" : c.channelId}
                placeholder="e.g. 8949 (Enter your Channel ID)"
                onChange={(e) => set("channelId")(e.target.value)}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Funds settle directly into your external registered Till, Paybill, or Bank.
              </p>
            </Field>
          )}

          <Field label="API Token (Basic / API Key)">
            <input
              type="password"
              className={inputCls + " font-mono"}
              value={c.apiToken}
              placeholder="API Token or Basic Key"
              onChange={(e) => set("apiToken")(e.target.value)}
            />
          </Field>
          <div className="relative flex items-center justify-center">
            <span className="bg-card px-2 text-xs text-muted-foreground">OR HTTP Basic Auth</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Username">
              <input
                className={inputCls}
                value={c.username}
                placeholder="Username"
                onChange={(e) => set("username")(e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                type="password"
                className={inputCls}
                value={c.password}
                placeholder="Password"
                onChange={(e) => set("password")(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <Button onClick={handleSaveClick} disabled={saving} className="h-10 w-full font-medium">
          {saving ? "Saving to Cloud…" : "Save FinoQ Settings"}
        </Button>
      </div>

      {authOpen && (
        <form onSubmit={confirmSave} className="mt-4 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-primary">Security Code Required</div>
          <p className="text-xs text-muted-foreground">Enter master security code to confirm changes to live FinoQ settings.</p>
          <input
            type="password"
            autoFocus
            className={inputCls + " font-mono"}
            placeholder="Enter security code"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setAuthOpen(false)} className="flex-1">Cancel</Button>
            <Button type="submit" disabled={saving} className="flex-1">{saving ? "Saving…" : "Confirm & Save"}</Button>
          </div>
        </form>
      )}
    </Panel>
  );
}

function PasscodeCard() {
  const [securityCode, setSecurityCode] = useState("");
  const [newPasscode, setNewPasscode] = useState("");
  const [saving, setSaving] = useState(false);
  const savePasscodeCloud = useServerFn(updateMasterPasscode);

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!securityCode.trim()) {
      toast.error("Please enter master security code");
      return;
    }
    const check = changePasscode(securityCode.trim(), newPasscode.trim());
    if (!check.ok) {
      toast.error(check.error || "Invalid passcode");
      return;
    }
    setSaving(true);
    try {
      await savePasscodeCloud({ data: { currentSecurityCode: securityCode.trim(), newPasscode: newPasscode.trim() } });
      write(KEYS.passcode, newPasscode.trim());
      toast.success("Admin passcode updated successfully!");
      setSecurityCode("");
      setNewPasscode("");
    } catch (err: any) {
      toast.error(err?.message || "Failed to update admin passcode");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel title="Admin Master Passcode" icon={<KeyRound className="h-4 w-4" />}>
      <form onSubmit={handleUpdate} className="space-y-3">
        <Field label="Master Security Code">
          <input
            type="password"
            className={inputCls}
            placeholder="Enter master security code"
            value={securityCode}
            onChange={(e) => setSecurityCode(e.target.value)}
          />
        </Field>
        <Field label="New Admin Passcode (4-8 digits)">
          <input
            type="password"
            className={inputCls + " font-mono"}
            placeholder="Enter new passcode (4-8 digits)"
            value={newPasscode}
            onChange={(e) => setNewPasscode(e.target.value)}
          />
        </Field>
        <Button
          type="submit"
          disabled={saving || !newPasscode}
          className="h-10 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:brightness-110"
        >
          {saving ? "Updating Passcode…" : "Update Admin Passcode"}
        </Button>
      </form>
    </Panel>
  );
}

function AppSettingsCard() {
  const [saved, setSaved] = useConfig();
  const [runningVer] = useAppVersion();
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
      // Preserve live mode: never overwrite live status from general app settings
      await saveCloudSettings({ data: { ...next, live: undefined } });
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
        <div className="rounded-xl border border-primary/30 bg-primary/10 p-3.5 text-sm">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Installed App Version</div>
          <div className="mt-1 font-bold text-primary text-base flex items-center gap-2">
            <span>This app is installed on:</span>
            <span className="font-mono bg-primary/20 px-2.5 py-0.5 rounded text-primary text-base font-extrabold">v{runningVer}</span>
          </div>
        </div>
        <Field label="APK download link"><input className={inputCls} value={c.apkUrl} placeholder="https://…/global-networks.apk" onChange={(e) => setC({ ...c, apkUrl: e.target.value })} /></Field>
        <Field label="Target Version for Updates (fill new version here)">
          <input className={inputCls + " font-mono"} value={c.latestVersion} onChange={(e) => setC({ ...c, latestVersion: e.target.value })} />
        </Field>
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
  const [manualPassword, setManualPassword] = useState("");
  const [isCaptive, setIsCaptive] = useState(false);
  const [editing, setEditing] = useState<Network | null>(null);
  const [pendingCaptiveNetwork, setPendingCaptiveNetwork] = useState<Network | null>(null);
  const [stamping, setStamping] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const deleteNetwork = useServerFn(removeCloudNetwork);
  const pushNetworks = useServerFn(syncCloudNetworks);
  const cur = device.currentWifi;

  const refreshWifi = async () => {
    setDetecting(true);
    try {
      if (Capacitor.isNativePlatform()) {
        const state = await GlobalRelay.getState();
        if (state.ssid && state.bssid) {
          const previous = read<Device>(KEYS.device, defaultDevice);
          write(KEYS.device, {
            ...previous,
            currentWifi: { ssid: state.ssid, bssid: state.bssid }
          });
          toast.success(`Detected Wi-Fi: ${state.ssid} (${state.bssid})`);
        } else {
          toast.info("Turn on phone Location (GPS) and connect to Wi-Fi to auto-detect router MAC");
        }
      } else {
        toast.info("Wi-Fi hardware auto-detection runs on Android");
      }
    } finally {
      setDetecting(false);
    }
  };

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

    const network: Network = { id: uid(), ssid: rawSsid, bssid: rawBssid, venue: venue.trim(), addedAt: Date.now(), password: manualPassword.trim() || undefined };

    // If captive is checked, register network into pool first so credentials foreign keys succeed
    if (isCaptive) {
      const nextNetworks = [network, ...networks];
      setNetworks(nextNetworks);
      void saveShared(KEYS.networks, nextNetworks).catch(() => {});
      void pushNetworks({ data: { networks: [network] } }).catch(() => {});
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
      setManualPassword("");
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
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">Connected Wi-Fi (Hardware Router BSSID)</div>
          <Button variant="ghost" size="sm" onClick={refreshWifi} disabled={detecting} className="h-6 text-[11px] px-2 text-primary hover:bg-primary/10">
            {detecting ? "Detecting..." : "Detect Wi-Fi"}
          </Button>
        </div>
        <div className="font-medium">
          {cur ? (
            <div className="space-y-1">
              <div className="text-sm font-semibold text-foreground">{cur.ssid}</div>
              <div className="font-mono text-xs text-muted-foreground">Router MAC / BSSID: <span className="text-primary font-bold">{cur.bssid}</span></div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <span className="text-warning text-xs">Turn on Location (GPS) & connect to Wi-Fi to auto-detect:</span>
              <input
                className={inputCls}
                placeholder="Type Wi-Fi name (SSID) to stamp, e.g. Safaricom_Hotspot"
                value={manualSsid}
                onChange={(e) => setManualSsid(e.target.value)}
              />
              <input
                className={inputCls + " font-mono text-xs"}
                placeholder="Router hardware BSSID (MAC, e.g. 00:1A:2B:3C:4D:5E)"
                value={manualBssid}
                onChange={(e) => setManualBssid(e.target.value)}
              />
            </div>
          )}
        </div>
        <input className={inputCls} placeholder="Venue label (optional), e.g. Westlands Mall" value={venue} onChange={(e) => setVenue(e.target.value)} />
        <input
          type="text"
          className={inputCls}
          placeholder="Wi-Fi Password / WPA Passphrase (optional, for secured Wi-Fi)"
          value={manualPassword}
          onChange={(e) => setManualPassword(e.target.value)}
        />
        <label className="flex items-center gap-2.5 rounded-lg border border-border bg-background/50 p-2.5 text-xs font-medium cursor-pointer">
          <input
            type="checkbox"
            checked={isCaptive}
            onChange={(e) => setIsCaptive(e.target.checked)}
            className="h-4 w-4 rounded accent-[var(--primary)]"
          />
          <span>Requires captive portal login (auto-detects voucher, PIN, & portal URL)</span>
        </label>
        {isCaptive && (
          <p className="text-[11px] text-primary bg-primary/10 border border-primary/20 rounded p-2">
            Silent auto-detection active: Portal URL & voucher/PIN will be automatically picked and filled into the dialog. For user/pass, fill username manually and tap Save.
          </p>
        )}
        <Button onClick={stamp} disabled={stamping} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary font-semibold text-primary-foreground hover:brightness-110">
          <Plus className="h-4 w-4" />{isCaptive ? "Configure & Save Captive Wi-Fi" : "Save Wi-Fi Network into Pool"}
        </Button>
      </div>
      <div className="mt-4 pt-3 border-t border-border">
        <Button
          type="button"
          variant="outline"
          onClick={() => setListOpen(true)}
          className="flex h-12 w-full items-center justify-between rounded-lg border border-border bg-background/50 px-4 text-xs font-semibold hover:bg-secondary"
        >
          <span className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-primary" /> Stamped Wi-Fi Networks
          </span>
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 font-mono text-xs text-primary font-bold">
            {networks.length} stamped
          </span>
        </Button>
      </div>

      {listOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => setListOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-xl border border-border bg-card p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center gap-2">
                <Wifi className="h-4 w-4 text-primary" />
                <h3 className="font-semibold text-base">Stamped Wi-Fi Networks</h3>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary font-mono">{networks.length}</span>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setListOpen(false)} aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto py-3 space-y-2">
              {networks.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">No networks stamped yet.</p>
              ) : (
                networks.map((n) => (
                  <div key={n.id} className="flex items-center gap-2 rounded-lg border border-border bg-background/50 p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium flex items-center gap-1.5">
                      <span>{n.ssid}</span>
                      {n.password && (
                        <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-mono text-primary font-normal">WPA Secured</span>
                      )}
                    </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">{n.bssid}{n.venue ? ` • ${n.venue}` : ""}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      title={n.password ? "Change WPA2 Password" : "Set WPA2 Password"}
                      onClick={() => {
                        const newPass = window.prompt(`Enter WPA2 password for ${n.ssid}:`, n.password || "");
                        if (newPass !== null) {
                          const updated = networks.map((x) =>
                            x.id === n.id ? { ...x, password: newPass.trim() || undefined } : x
                          );
                          setNetworks(updated);
                          void saveShared(KEYS.networks, updated).catch(() => {});
                          resolveNetworkAlert(n.ssid);
                          toast.success(`Password for ${n.ssid} saved!`);
                        }
                      }}
                      className="h-8 w-8 rounded-lg text-accent hover:bg-accent/10"
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="outline" size="icon" title="Captive Portal Login" onClick={() => setEditing(n)} className="h-8 w-8 rounded-lg text-primary hover:bg-primary/10">
                      <KeyRound className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={async () => {
                        const next = networks.filter((x) => x.id !== n.id && x.bssid.toUpperCase() !== n.bssid.toUpperCase());
                        setNetworks(next);
                        void saveShared(KEYS.networks, next).catch(() => {});
                        try {
                          await deleteNetwork({ data: { id: n.id } });
                        } catch {}
                        toast("Removed from pool");
                      }}
                      className="h-8 w-8 text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-border pt-3 flex justify-end">
              <Button onClick={() => setListOpen(false)} className="h-9 px-4 text-xs font-semibold">Done</Button>
            </div>
          </div>
        </div>
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


function BlockedNumbersCard() {
  const [blocked, setBlocked] = useBlockedNumbers();
  const [newPhone, setNewPhone] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const saveBlockedList = useServerFn(saveBlockedNumbers);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const normalized = normalizePhone(newPhone);
    if (!normalized || normalized.length < 9) {
      toast.error("Please enter a valid phone number (e.g. 0712345678)");
      return;
    }
    if (blocked.some((b: BlockedNumber) => normalizePhone(b.phone) === normalized)) {
      toast.error("This phone number is already blocked");
      return;
    }
    setSaving(true);
    const updated: BlockedNumber[] = [
      ...blocked,
      { phone: normalized, reason: reason.trim() || "Blocked by administrator", addedAt: Date.now() },
    ];
    try {
      await saveBlockedList({ data: { numbers: updated } });
      setBlocked(updated);
      write(KEYS.blockedNumbers, updated);
      setNewPhone("");
      setReason("");
      toast.success(`+${normalized} has been blocked and active sessions frozen.`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save blocked number to cloud");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(phone: string) {
    const updated = blocked.filter((b: BlockedNumber) => b.phone !== phone);
    try {
      await saveBlockedList({ data: { numbers: updated } });
      setBlocked(updated);
      write(KEYS.blockedNumbers, updated);
      toast.success(`Unblocked +${phone}. Services restored.`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to update blocked numbers list");
    }
  }

  return (
    <div className="space-y-4">
      <Panel title="Block a Phone Number" icon={<Ban className="h-4 w-4 text-destructive" />}>
        <form onSubmit={handleAdd} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Phone Number</label>
              <input
                type="tel"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="0712345678"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:border-destructive focus:outline-none"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Reason (Optional)</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Misuse / Payment fraud"
                className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-1.5 text-xs focus:border-destructive focus:outline-none"
              />
            </div>
          </div>
          <Button type="submit" disabled={saving} variant="destructive" className="h-8 w-full text-xs">
            {saving ? "Saving..." : "Block Phone Number (Cut Access & Disable Pay)"}
          </Button>
        </form>
      </Panel>

      <Panel title={`Currently Blocked (${blocked.length})`} icon={<ShieldAlert className="h-4 w-4" />}>
        <Table
          head={["Phone Number", "Reason", "Blocked Date", "Action"]}
          empty="No numbers currently blocked. All users can access services."
          rows={blocked.map((item: BlockedNumber) => [
            <span className="font-mono font-semibold text-destructive">+{item.phone}</span>,
            item.reason || "—",
            new Date(item.addedAt).toLocaleDateString(),
            <Button
              key={item.phone}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs text-primary border-primary/40 hover:bg-primary/10"
              onClick={() => handleRemove(item.phone)}
            >
              Unblock
            </Button>,
          ])}
        />
      </Panel>
    </div>
  );
}
