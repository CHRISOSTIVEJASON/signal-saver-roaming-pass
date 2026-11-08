import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PASSCODE } from "./rules";
import { cached, isSharedKey, saveShared, useCached } from "./cloud-cache";
import type { MeshLink } from "./relay";
import { toast } from "sonner";

export type PayConfig = {
  apiToken: string;
  username: string;
  password: string;
  channelId: string;
  live: boolean;
  apkUrl: string;
  latestVersion: string;
  updateRequired: boolean;
};
export type Perm = "unset" | "granted" | "denied";
export type WifiInfo = { ssid: string; bssid: string };
/** Simulated Android device state (a web page cannot read real Wi-Fi or permissions). */
export type Device = {
  appMode: boolean;
  onboarded: boolean;
  perms: { background: Perm; wifi: Perm; relay: Perm };
  currentWifi: WifiInfo | null;
  personalSsids: string[];
  relay?: MeshLink | null;
  captive?: { bssid: string; ready: boolean; required: boolean } | null;
};
export const defaultDevice: Device = {
  appMode: false, onboarded: false,
  perms: { background: "unset", wifi: "unset", relay: "unset" },
  currentWifi: null, personalSsids: ["My Home Wi-Fi"],
};
export type Network = { id: string; ssid: string; bssid: string; venue: string; addedAt: number };
export type Session = {
  id: string;
  phone: string;
  passId: string;
  totalMs: number;
  remainingMs: number;
  lastTick: number;
  online: boolean;
  startedAt: number;
};
export type Txn = {
  id: string;
  phone: string;
  amount: number;
  passId: string;
  ref: string;
  at: number;
  status: "Pending" | "Activated" | "Failed";
  mode: "Live" | "Demo";
};

export const KEYS = {
  passcode: "gn_passcode",
  config: "gn_payhero",
  networks: "gn_networks",
  sessions: "gn_sessions",
  txns: "gn_txns",
  active: "gn_active_session",
  relay: "gn_relay",
  device: "gn_device",
  mesh: "gn_mesh_links",
};

export const defaultConfig: PayConfig = { apiToken: "", username: "", password: "", channelId: "", live: false, apkUrl: "", latestVersion: "1.0.0", updateRequired: false };
export const readConfig = (): PayConfig => ({ ...defaultConfig, ...read<Partial<PayConfig>>(KEYS.config, {}) });

export function read<T>(key: string, fallback: T): T {
  if (isSharedKey(key)) return cached(key, fallback);
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function write<T>(key: string, v: T) {
  if (isSharedKey(key)) { void saveShared(key, v).catch((error) => toast.error(error.message)); return; }
  localStorage.setItem(key, JSON.stringify(v));
  window.dispatchEvent(new CustomEvent("gn-store", { detail: key }));
}

/** localStorage-backed state, read after hydration to avoid SSR mismatches. */
export function useStored<T>(key: string, fallback: T) {
  const cloudVal = useCached(key, fallback);
  const [val, setVal] = useState<T>(fallback);
  useEffect(() => {
    setVal(read(key, fallback));
    const on = (e: Event) => {
      const k = (e as CustomEvent).detail ?? (e as StorageEvent).key;
      if (k === key) setVal(read(key, fallback));
    };
    window.addEventListener("gn-store", on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener("gn-store", on);
      window.removeEventListener("storage", on);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const set = useCallback(
    (next: T | ((p: T) => T)) => {
      const cur = read(key, fallback);
      const v = typeof next === "function" ? (next as (p: T) => T)(cur) : next;
      if (isSharedKey(key)) { void saveShared(key, v).catch((error) => toast.error(error.message)); return; }
      write(key, v);
      setVal(v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
  return [isSharedKey(key) ? cloudVal : val, set] as const;
}

export const getPasscode = () => read(KEYS.passcode, DEFAULT_PASSCODE);
export const uid = () => Math.random().toString(36).slice(2, 10).toUpperCase();

export type RelayEvent = { id: string; at: number; from: string; peer: string; via: string; kb: number; kind: "assist" | "received" };
export type RelayLog = { assistedKb: number; receivedKb: number; events: RelayEvent[] };
export const emptyRelay: RelayLog = { assistedKb: 0, receivedKb: 0, events: [] };

/** Simulated background peer-assist: called once per second while a pass is online. */
export function recordRelayTick(phone: string) {
  if (read<Device>(KEYS.device, defaultDevice).relay?.source === "native") return;
  if (Math.random() > 0.35) return;
  const log = read<RelayLog>(KEYS.relay, emptyRelay);
  const nets = read<Network[]>(KEYS.networks, []);
  const kind: RelayEvent["kind"] = Math.random() < 0.6 ? "assist" : "received";
  const kb = Math.round(40 + Math.random() * 900);
  const ev: RelayEvent = {
    id: uid(), at: Date.now(), from: phone, kb, kind,
    peer: "Peer-" + Math.random().toString(16).slice(2, 6).toUpperCase(),
    via: nets.length ? (nets[Math.floor(Math.random() * nets.length)]?.ssid ?? "Direct") : "Direct",
  };
  write(KEYS.relay, {
    assistedKb: log.assistedKb + (kind === "assist" ? kb : 0),
    receivedKb: log.receivedKb + (kind === "received" ? kb : 0),
    events: [ev, ...log.events].slice(0, 200),
  });
}
