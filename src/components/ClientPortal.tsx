import { useEffect, useRef, useState } from "react";
import { Home, Loader2, Search, Smartphone, Snowflake, Zap, Signal, MapPin, Volume2, VolumeX, Laptop, Share2, Wifi, Copy, Check, Users, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PASSES, connectionState, formatClock, getPass, normalizePhone, tick, shouldAlertNetwork, ALERT_COOLDOWN_MS, type WifiState } from "@/lib/rules";
import { KEYS, defaultDevice, defaultConfig, read, recordRelayTick, uid, useStored, useBeepAlerts, getBeepAlertsEnabled, useExemptedNumbers, useOffers, useServiceStatus, type Device, type Network, type Session, type Txn, type PayConfig } from "@/lib/store";
import { useConfig } from "./Gates";
import { useServerFn } from "@tanstack/react-start";
import { startCloudPayment, confirmCloudPayment, restoreCloudPass, pairCompanionPass, unpairCompanionPass } from "@/lib/cloud.functions";
import { contributeNetworkAndCaptive } from "@/lib/captive.functions";
import { saveShared } from "@/lib/cloud-cache";
import { GlobalRelay } from "@/lib/native-relay";
import { getDeviceId } from "@/lib/store";
import { X } from "lucide-react";
import { relayProvidesConnection, getCompanionPin } from "@/lib/relay";
import { Button } from "./ui/button";
import { Capacitor } from "@capacitor/core";
import { CaptiveLogin } from "./CaptiveLogin";

function currentState(): { state: WifiState; ssid: string | undefined } {
  const d = read<Device>(KEYS.device, defaultDevice);
  const nets = read<Network[]>(KEYS.networks, []);
  return {
    state: relayProvidesConnection(d.relay, Date.now())
      ? "pool"
      : connectionState(
          d.currentWifi,
          nets.map((n) => n.bssid),
          d.personalSsids,
          nets.map((n) => n.ssid)
        ),
    ssid: d.currentWifi?.ssid,
  };
}

/** Live Wi-Fi state, re-read whenever the device or pool changes. */
function useWifiState() {
  const [device] = useStored<Device>(KEYS.device, defaultDevice);
  const [nets] = useStored<Network[]>(KEYS.networks, []);
  return {
    state: relayProvidesConnection(device.relay, Date.now())
      ? "pool"
      : connectionState(
          device.currentWifi,
          nets.map((n) => n.bssid),
          device.personalSsids,
          nets.map((n) => n.ssid)
        ),
    ssid: device.currentWifi?.ssid,
    direct: relayProvidesConnection(device.relay, Date.now()),
  };
}

function LocationAlert() {
  const { state, direct } = useWifiState();
  if (state === "pool" || direct) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
      <MapPin className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" />
      <div className="text-left leading-relaxed">
        <span className="font-semibold block">Turn on Location to use Wi-Fi</span>
        <span>Keep your phone's Location (GPS) ON so the app can sense nearby pool Wi-Fi and connect your pass automatically.</span>
      </div>
    </div>
  );
}

const LAST_ALERT_KEY = "gn_last_network_alert";
const COOLDOWN_MS = 20 * 60 * 1000;

function playWebThreeBeepTone() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const times = [0, 0.85, 1.7];
    times.forEach((startTime) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime + startTime);
      gain.gain.setValueAtTime(0.25, ctx.currentTime + startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startTime);
      osc.stop(ctx.currentTime + startTime + 0.35);
    });
  } catch (_) {}
}

export function triggerNetworkAlertTone() {
  if (!getBeepAlertsEnabled()) return;
  const last = parseInt(localStorage.getItem(LAST_ALERT_KEY) || "0", 10);
  const now = Date.now();
  if (!shouldAlertNetwork(last, now, ALERT_COOLDOWN_MS)) return;
  localStorage.setItem(LAST_ALERT_KEY, String(now));
  if (Capacitor.isNativePlatform()) {
    void GlobalRelay.playBeepTone().catch(() => playWebThreeBeepTone());
  } else {
    playWebThreeBeepTone();
  }
}

export function ClientPortal() {
  const [activeId, setActiveId] = useStored<string | null>(KEYS.active, null);
  const [sessions, setSessions] = useStored<Session[]>(KEYS.sessions, []);
  const [buying, setBuying] = useState(false);
  const session = sessions.find((s) => s.id === activeId && s.remainingMs > 0) ?? sessions.find((s) => s.remainingMs > 0);

  if (session && !buying) return <ActiveSession session={session} setSessions={setSessions} onEnd={() => setBuying(true)} />;
  return <Purchase onActivated={(s) => { setSessions((p) => [{ ...s, lastTick: Date.now() }, ...p.filter((x) => x.id !== s.id)]); setActiveId(s.id); setBuying(false); }} />;
}


function NetworkBadge() {
  const { state, ssid } = useWifiState();
  const [device] = useStored<Device>(KEYS.device, defaultDevice);
  const [beepAlerts, setBeepAlerts] = useBeepAlerts();

  const toggleSound = () => {
    const next = !beepAlerts;
    setBeepAlerts(next);
    toast.info(next ? "Nearby Wi-Fi sound alert enabled (3 beeps)" : "Nearby Wi-Fi sound alert muted");
  };

  const badgeContent = state === "pool" ? (
    <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
      <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      Network Connected • {ssid || "Pool"}
    </span>
  ) : device.nearbyPoolDetected ? (
    <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
      <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
      Sensed Nearby • {device.nearbySsid || "Pool"}
    </span>
  ) : (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-xs font-medium text-muted-foreground">
      <Search className="h-3.5 w-3.5" />
      Searching for network…
    </span>
  );

  return (
    <div className="inline-flex items-center gap-1.5">
      {badgeContent}
      <button
        type="button"
        onClick={toggleSound}
        aria-label={beepAlerts ? "Mute alert sound" : "Enable alert sound"}
        title={beepAlerts ? "Alert sound is ON (tap to mute)" : "Alert sound is MUTED (tap to enable)"}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-card/60 text-muted-foreground transition hover:text-foreground"
      >
        {beepAlerts ? <Volume2 className="h-3.5 w-3.5 text-primary" /> : <VolumeX className="h-3.5 w-3.5 text-muted-foreground/60" />}
      </button>
    </div>
  );
}

function Purchase({ onActivated }: { onActivated: (s: Session) => void }) {
  const [cfg] = useConfig();
  const [offers] = useOffers();
  const [passId, setPassId] = useState<string>(offers[0]?.id || "p30");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [, setTxns] = useStored<Txn[]>(KEYS.txns, []);
  const pass = getPass(passId, offers);

  const { state, ssid, direct } = useWifiState();
  const [device] = useStored<Device>(KEYS.device, defaultDevice);
  const isNetworkAvailable = state === "pool" || direct || Boolean(device.nearbyPoolDetected);
  const detectedName = ssid || device.nearbySsid || "Roaming Pool";

  useEffect(() => {
    if (isNetworkAvailable) {
      triggerNetworkAlertTone();
    }
  }, [isNetworkAvailable]);

  const startPayment = useServerFn(startCloudPayment);
  const confirmPayment = useServerFn(confirmCloudPayment);
  const restorePass = useServerFn(restoreCloudPass);
  const pairCompanion = useServerFn(pairCompanionPass);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePhone, setRestorePhone] = useState("");
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairPhone, setPairPhone] = useState("");
  const [pairPin, setPairPin] = useState("");
  const [pairBusy, setPairBusy] = useState(false);

  const updateTxn = (id: string, patch: Partial<Txn>) =>
    setTxns((p) => p.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  async function pay() {
    const msisdn = normalizePhone(phone);
    if (!msisdn) { toast.error("Enter a valid Safaricom number (07… or 01…)"); return; }

    setBusy("Sending M-Pesa prompt to your phone…");
    const deviceId = getDeviceId();
    let currentTxnId = uid();
    try {
      const r = await startPayment({ data: { phone: msisdn, passId: pass.id, deviceId } });
      currentTxnId = r.id;
      const ref = r.ref || ("GN" + uid());

      if ((r as any).exempted && (r as any).session) {
        setBusy("VIP number recognized! Activating access...");
        setTxns((p) => [{ id: r.id, phone: msisdn, amount: 0, passId, ref, at: Date.now(), status: "Activated", mode: "Exempted" as any }, ...p]);
        onActivated((r as any).session);
        toast.success(`🎉 Phone number exempted! Joined with ${pass.label} (KES 0 charged).`);
        return;
      }

      setTxns((p) => [{ id: r.id, phone: msisdn, amount: pass.amount, passId, ref, at: Date.now(), status: "Pending", mode: r.live ? "Live" : "Demo" }, ...p]);

      if (r.live) {
        setBusy("Prompt sent! Enter your M-Pesa PIN on your phone…");
        let ok = false;
        let activatedSession: Session | null = null;
        // Poll for up to 90 seconds (60 iterations @ 1.5s interval)
        for (let i = 0; i < 60 && !ok; i++) {
          if (i > 0) {
            await new Promise((res) => setTimeout(res, 1500));
          }
          if (i === 10) setBusy("Awaiting M-Pesa PIN approval…");
          if (i === 25) setBusy("Verifying with Safaricom Daraja gateway…");

          try {
            const st = await confirmPayment({ data: { id: r.id, deviceId } });
            if (!st.pending && st.session) {
              ok = true;
              activatedSession = st.session;
              break;
            }
          } catch (pollErr: any) {
            // Transient network blips or temporary gateway lags must NOT kill the polling loop!
            const errMsg = String(pollErr?.message || "").toLowerCase();
            if (errMsg.includes("cancelled") || errMsg.includes("declined") || errMsg.includes("wrong pin")) {
              throw pollErr;
            }
            console.warn("Polling status notice, continuing loop:", pollErr);
          }
        }
        if (!ok || !activatedSession) {
          throw new Error("Payment verification taking longer than expected. If you entered your PIN, tap 'Check Pass / Active Status' below.");
        }
        setBusy("M-Pesa confirmed! Activating high-speed pass…");
        updateTxn(r.id, { status: "Activated" });
        onActivated(activatedSession);
        toast.success("Payment confirmed! High-speed pass activated.");
      } else {
        setBusy("Activating Demo pass (Test mode)…");
        await new Promise((res) => setTimeout(res, 800));
        const st = await confirmPayment({ data: { id: r.id, deviceId } });
        if (!st.session) throw new Error("Demo pass could not be activated");
        updateTxn(r.id, { status: "Activated" });
        onActivated(st.session);
        toast.success("Demo pass activated — no money charged (Test mode)");
      }
    } catch (e) {
      updateTxn(currentTxnId, { status: "Failed" });
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
        toast.success(`Active pass found • ${formatClock(res.session.remainingMs)} remaining`);
        setRestoreOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to restore pass");
    } finally {
      setRestoreBusy(false);
    }
  }

  async function handlePairCompanion(e: React.FormEvent) {
    e.preventDefault();
    const msisdn = normalizePhone(pairPhone);
    if (!msisdn) {
      toast.error("Enter a valid host phone number (07… or 01…)");
      return;
    }
    if (!pairPin.trim()) {
      toast.error("Enter the 6-digit companion PIN shown on the host device");
      return;
    }
    setPairBusy(true);
    try {
      const res = await pairCompanion({ data: { phone: msisdn, pin: pairPin.trim(), deviceId: getDeviceId() } });
      if (res?.session) {
        onActivated(res.session);
        toast.success("🎉 Companion tied successfully! Locked to this device.");
        setPairOpen(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to pair companion");
    } finally {
      setPairBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center justify-center gap-2">
        <NetworkBadge />
        {isNetworkAvailable && (
          <div className="w-full flex items-center gap-2.5 rounded-xl border border-primary/40 bg-primary/10 p-3 text-xs text-primary shadow-sm animate-pulse">
            <Zap className="h-4 w-4 shrink-0 text-primary" />
            <div className="text-left leading-tight">
              <span className="font-semibold block text-xs">Network available, kindly consider paying.</span>
              <span className="text-[11px] text-muted-foreground">
                Sensed {detectedName} in range. Choose a pass below to start high-speed roaming.
              </span>
            </div>
          </div>
        )}
        {cfg.live ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-primary font-medium">
            <span className="h-2 w-2 rounded-full bg-primary animate-pulse" />
            Live M-Pesa STK Push
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-500 font-medium">
            ⚡ Demo Mode (Admin can activate Live in Console)
          </span>
        )}
      </div>
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
        <div className="grid grid-cols-1 gap-2 pt-2 min-[380px]:grid-cols-2">
          <Button
            variant="outline"
            type="button"
            onClick={() => setRestoreOpen(true)}
            className="h-auto min-h-10 w-full min-w-0 whitespace-normal px-3 py-2 text-xs leading-tight"
          >
            <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 break-words">Check Pass / Restore</span>
          </Button>
          <Button
            variant="outline"
            type="button"
            onClick={() => setPairOpen(true)}
            className="h-auto min-h-10 w-full min-w-0 whitespace-normal px-3 py-2 text-xs leading-tight"
          >
            <Laptop className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="min-w-0 break-words">Pair Companion</span>
          </Button>
        </div>
      </div>
      {restoreOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => setRestoreOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base">Check Pass / Active Status</h3>
              <Button variant="ghost" size="icon" onClick={() => setRestoreOpen(false)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">Enter the phone number used for your pass (paid or VIP). We'll show your remaining time and companion pairing, and move the pass to this phone if you reinstalled the app.</p>
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
                  {restoreBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check Pass"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
      {pairOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" onClick={() => setPairOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-5 shadow-lg">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Laptop className="h-5 w-5 text-primary" />
                <h3 className="font-semibold text-base">Pair Companion Device</h3>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPairOpen(false)} aria-label="Close"><X className="h-4 w-4" /></Button>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Ride on an active pass from your primary phone without paying twice. <strong>Protection B:</strong> Exactly <strong>1 companion device</strong> is permitted. Additional devices are blocked.
            </p>
            <form onSubmit={handlePairCompanion} className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground uppercase font-mono tracking-wider">Host Phone Number</label>
                <div className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring">
                  <Smartphone className="h-4 w-4 text-muted-foreground" />
                  <input
                    autoFocus
                    type="tel"
                    placeholder="07XX XXX XXX"
                    value={pairPhone}
                    onChange={(e) => setPairPhone(e.target.value)}
                    className="h-10 w-full bg-transparent font-mono text-sm outline-none"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground uppercase font-mono tracking-wider">6-Digit Companion PIN</label>
                <input
                  type="text"
                  maxLength={8}
                  placeholder="e.g. 842109"
                  value={pairPin}
                  onChange={(e) => setPairPin(e.target.value)}
                  className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-base font-bold tracking-widest outline-none focus:ring-2 focus:ring-ring"
                  required
                />
              </div>
              <div className="flex gap-2 pt-1">
                <Button type="button" onClick={() => setPairOpen(false)} className="h-10 flex-1 rounded-lg border border-border text-sm">Cancel</Button>
                <Button type="submit" disabled={pairBusy} className="h-10 flex-1 rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
                  {pairBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Pair & Unlock"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}


function CompanionSharing({ session, onUpdateSession }: { session: Session; onUpdateSession?: (patch: Partial<Session>) => void }) {
  const [deviceState] = useStored<Device>(KEYS.device, defaultDevice);
  const [exemptedList] = useExemptedNumbers();
  const [copied, setCopied] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const unpairCompanion = useServerFn(unpairCompanionPass);
  const isNative = Capacitor.isNativePlatform();

  const networkName = deviceState.relay?.networkName || ("GN-SHARE-" + (session.phone.replace(/\D/g, "").slice(-4) || "PASS"));
  const pin = session.companionPin || getCompanionPin(deviceState.relay?.passphrase, session.phone);
  const peerCount = deviceState.relay?.peerCount ?? 0;
  
  const normPhone = normalizePhone(session.phone);
  const isExempt = exemptedList.some((e) => e.phone === normPhone || e.phone === session.phone);
  const isTied = Boolean(session.pairedCompanionId);

  const handleUnpair = async () => {
    setUnpairing(true);
    try {
      await unpairCompanion({ data: { phone: session.phone, deviceId: getDeviceId() } });
      toast.success("Companion slot released. You can now pair a different device.");
      onUpdateSession?.({ pairedCompanionId: null });
    } catch (e: any) {
      toast.error(e?.message || "Failed to release companion");
    } finally {
      setUnpairing(false);
    }
  };

  const copyPin = () => {
    try {
      navigator.clipboard?.writeText?.(pin);
      setCopied(true);
      toast.success("Companion PIN copied: " + pin);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.success("PIN: " + pin);
    }
  };

  const handleOpenHotspot = async () => {
    try {
      if (typeof (GlobalRelay as any).openHotspotSettings === "function") {
        await (GlobalRelay as any).openHotspotSettings();
      } else {
        await GlobalRelay.openSettings();
      }
    } catch {
      await GlobalRelay.openSettings();
    }
  };

  return (
    <div className="mt-4 overflow-hidden rounded-xl border border-border bg-card/70 p-4 text-left shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between pb-2.5 border-b border-border/50">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Share2 className="h-4 w-4" />
          </div>
          <div>
            <h4 className="text-sm font-semibold flex items-center gap-1.5">
              Companion & Laptop Sharing
              {isExempt && (
                <span className="rounded-full bg-emerald-500/10 text-emerald-500 px-1.5 py-0.5 text-[10px] font-medium border border-emerald-500/20">
                  VIP Free
                </span>
              )}
            </h4>
            <p className="text-[11px] text-muted-foreground">Share this active pass with your laptop or phone</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Active
        </span>
      </div>

      {isNative ? (
        <div className="space-y-3 pt-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-secondary/50 p-2.5 border border-border/40">
              <span className="text-[10px] text-muted-foreground uppercase font-mono tracking-wider block">Wi-Fi Name (SSID)</span>
              <span className="font-mono font-medium text-foreground truncate block mt-0.5">{networkName}</span>
            </div>
            <div className="rounded-lg bg-secondary/50 p-2.5 border border-border/40 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-muted-foreground uppercase font-mono tracking-wider block">6-Digit PIN</span>
                <span className="font-mono text-base font-bold text-primary block mt-0.5 tracking-widest">{pin}</span>
              </div>
              <Button size="icon" variant="ghost" onClick={copyPin} className="h-7 w-7 text-muted-foreground hover:text-foreground">
                {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>

          {/* Protection B Device Binding Status */}
          <div className="rounded-lg border border-border/40 bg-secondary/30 p-2.5 text-[11px] space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-foreground flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Protection B: 1-Device Lock
              </span>
              {isTied ? (
                <span className="rounded-full bg-primary/15 text-primary px-2 py-0.5 text-[10px] font-semibold border border-primary/30">
                  🔒 1 Companion Locked
                </span>
              ) : (
                <span className="rounded-full bg-amber-500/15 text-amber-400 px-2 py-0.5 text-[10px] font-medium border border-amber-500/30">
                  1 Companion Slot Available
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              {isTied ? (
                <>Tied to your paired companion device. Any other device entering this PIN will be <strong>blocked</strong>.</>
              ) : (
                <>On your laptop or 2nd phone, open the portal and tap <strong>Pair Companion</strong> using PIN <strong className="text-primary font-mono">{pin}</strong> to lock to that device.</>
              )}
            </p>
            {isTied && (
              <div className="pt-1 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={unpairing}
                  onClick={handleUnpair}
                  className="h-7 text-[10px] rounded-md border-border text-muted-foreground hover:text-foreground"
                >
                  {unpairing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} Release / Switch Device
                </Button>
              </div>
            )}
          </div>

          <div className="rounded-lg bg-muted/40 p-2.5 text-[11px] space-y-1.5 text-muted-foreground border border-border/30">
            <div className="font-medium text-foreground text-[12px] flex items-center gap-1.5">
              <Laptop className="h-3.5 w-3.5 text-primary" /> How to connect from Laptop or 2nd phone:
            </div>
            <ol className="list-decimal list-inside space-y-1 pl-1">
              <li>Open Wi-Fi on your laptop/phone and connect to <span className="font-mono text-foreground font-semibold">{networkName}</span>.</li>
              <li>Enter the 6-digit PIN <span className="font-mono text-foreground font-semibold">{pin}</span>.</li>
              <li>Or tap <strong>Open Hotspot Settings</strong> below to share your phone's personal hotspot directly.</li>
            </ol>
          </div>

          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5 text-primary" />
              Connected: <strong className="text-foreground">{peerCount}</strong> {peerCount === 1 ? "device" : "devices"}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenHotspot}
              className="h-8 text-xs gap-1.5 rounded-lg border-border"
            >
              <Wifi className="h-3.5 w-3.5 text-primary" /> Open Hotspot Settings
            </Button>
          </div>
        </div>
      ) : (
        /* Laptop / Desktop Web View */
        <div className="space-y-3 pt-3 text-xs text-muted-foreground">
          <div className="rounded-lg bg-muted/40 p-3 space-y-2 border border-border/40">
            <div className="font-medium text-foreground flex items-center gap-1.5 text-sm">
              <Smartphone className="h-4 w-4 text-primary" /> Share Laptop Internet with your Phone:
            </div>
            <p className="text-[12px] leading-relaxed">
              Your laptop is connected with an active pass. To share with your phone without paying twice:
            </p>
            <div className="space-y-1.5 pl-1 text-[11px]">
              <div>• <strong>Windows:</strong> Press <kbd className="rounded border px-1 py-0.5 font-mono text-[10px] bg-background">Win + A</kbd> and click <strong>Mobile Hotspot</strong>.</div>
              <div>• <strong>Mac:</strong> Open <strong>System Settings → Sharing → Internet Sharing</strong> and turn it on.</div>
            </div>
            <p className="text-[11px] text-foreground font-medium pt-1">
              Connect your phone to your laptop's Wi-Fi hotspot to browse freely on this active pass!
            </p>
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
  const [service] = useServiceStatus();
  const suspended = !service.active;
  const connecting = Capacitor.isNativePlatform() && state === "pool" && !direct && (!deviceState.captive?.ready || deviceState.captive.bssid !== deviceState.currentWifi?.bssid);

  const update = (patch: (s: Session) => Partial<Session>) =>
    setSessions((p) => p.map((s) => (s.id === ref.current.id ? { ...s, ...patch(s) } : s)));

  useEffect(() => {
    const step = () => {
      const now = Date.now();
      const running = state === "pool" && !connecting && !suspended;
      update((s) => ({ remainingMs: tick(s.remainingMs, s.lastTick, now, running), lastTick: now, online: running }));
      if (ref.current.online) recordRelayTick(ref.current.phone);
      force((n) => n + 1);
    };
    step();
    const t = setInterval(step, 1000);
    return () => clearInterval(t);
  }, [session.id, state, connecting, suspended]);

  const [offers] = useOffers();
  const remainingMs = tick(session.remainingMs, session.lastTick, Math.min(Date.now(), session.lastTick + 30_000), session.online);
  const pct = (remainingMs / session.totalMs) * 100;
  const pass = getPass(session.passId, offers);

  return (
    <div className="space-y-5 text-center">
      <CaptiveLogin sessionId={session.id} />
      {suspended && <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning"><Snowflake className="h-3.5 w-3.5 shrink-0" />Service paused — your time is frozen{service.resumeDate ? ` until ${service.resumeDate}` : ""}</span>}
      {connecting && <span className="inline-flex items-center gap-2 text-sm text-warning"><Loader2 className="h-4 w-4 animate-spin" />Connecting — your time is preserved</span>}
      {direct && <span className="inline-flex items-center justify-center gap-2 text-sm text-primary"><Signal className="h-5 w-5 shrink-0" />Connected to GLOBAL NETWORKS (High-Speed Direct Relay)</span>}
      {state === "pool" && !direct && !connecting && <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"><Zap className="h-3.5 w-3.5" />Connected automatically • {ssid}</span>}
      {state === "personal" && <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent"><Home className="h-3.5 w-3.5" />On your own Wi-Fi — your pass time is saved</span>}
      {state === "searching" && deviceState.nearbyPoolDetected && (
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/15 px-3 py-1.5 text-xs font-medium text-primary animate-pulse">
          <Zap className="h-3.5 w-3.5" />Sensed {deviceState.nearbySsid || "Pool Network"} • Connecting automatically
        </span>
      )}
      {state === "searching" && !deviceState.nearbyPoolDetected && <span className="inline-flex items-center gap-2 rounded-full border border-warning/40 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning"><Snowflake className="h-3.5 w-3.5" />Time Frozen — searching for network</span>}
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
            <CompanionSharing session={session} onUpdateSession={(patch) => update(() => patch)} />
      <div className="pt-2 flex flex-col gap-2">
        <Button variant="ghost" onClick={onEnd} className="text-xs text-muted-foreground underline-offset-4 hover:underline">Buy another pass</Button>
      </div>
    </div>
  );
}
