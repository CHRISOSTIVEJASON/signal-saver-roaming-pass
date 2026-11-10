import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PASSES as _DP, DEFAULT_PASSCODE, APP_VERSION, type PassOffer } from "./rules";
export const DEFAULT_PASSES = _DP;
export type { PassOffer } from "./rules";
import { cached, isSharedKey, publishCache, saveShared, useCached } from "./cloud-cache";
import type { MeshLink } from "./relay";
import { toast } from "sonner";

export type PayConfig = {
  apiToken: string;
  username: string;
  password: string;
  channelId: string;
  live?: boolean | undefined;
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
  nearbyPoolDetected?: boolean;
  nearbySsid?: string;
};
export const defaultDevice: Device = {
  appMode: false, onboarded: false,
  perms: { background: "unset", wifi: "unset", relay: "unset" },
  currentWifi: null, personalSsids: ["My Home Wi-Fi"],
};
export type Network = { id: string; ssid: string; bssid: string; venue: string; addedAt: number; password?: string | undefined };
export type Session = {
  id: string;
  phone: string;
  passId: string;
  totalMs: number;
  remainingMs: number;
  lastTick: number;
  online: boolean;
  startedAt: number;
  isCompanion?: boolean;
  pairedCompanionId?: string | null;
  companionPin?: string;
  frozen?: boolean;
  frozenAt?: number;
  unauthorized?: boolean;
  boundDeviceId?: string | null;
};
export type Txn = {
  id: string;
  phone: string;
  amount: number;
  passId: string;
  ref: string;
  at: number;
  status: "Pending" | "Activated" | "Failed" | "Underpaid";
  notes?: string;
  durationHours?: number;
  durationMs?: number;
  mode: "Live" | "Demo";
};

export type ServiceStatus = {
  active: boolean;
  resumeDate: string;
  updatedAt?: number;
};
export const defaultServiceStatus: ServiceStatus = {
  active: true,
  resumeDate: "",
};

export type BlockedNumber = {
  phone: string;
  reason?: string;
  addedAt: number;
};

export type ExemptedNumber = {
  phone: string;
  note?: string;
  addedAt: number;
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
  appVersion: "gn_app_version",
  beepAlerts: "gn_beep_alerts",
  serviceStatus: "gn_service_status",
  exemptedNumbers: "gn_exempted_numbers",
  blockedNumbers: "gn_blocked_numbers",
  offers: "gn_offers",
};

export const defaultConfig: PayConfig = { apiToken: "", username: "", password: "", channelId: "", live: false, apkUrl: "", latestVersion: "1.0.0", updateRequired: false };
export const readConfig = (): PayConfig => ({ ...defaultConfig, ...read<Partial<PayConfig>>(KEYS.config, {}) });

export function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return JSON.parse(v) as T;
  } catch {}
  if (isSharedKey(key)) return cached(key, fallback);
  return fallback;
}
export function write<T>(key: string, v: T) {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(key, JSON.stringify(v));
      window.dispatchEvent(new CustomEvent("gn-store", { detail: key }));
    } catch {}
  }
  try { publishCache(key, v); } catch {}
  if (isSharedKey(key)) {
    void saveShared(key, v).catch(() => {});
  }
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
      write(key, v);
      setVal(v);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
    if (isSharedKey(key)) {
    // Local device is the authority for client sessions and transactions
    if (key === KEYS.sessions || key === KEYS.txns) {
      return [val, set] as const;
    }
    return [cloudVal, set] as const;
  }
  return [val, set] as const;
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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getDeviceId(): string {
  if (typeof window === "undefined") return "00000000-0000-4000-8000-000000000000";
  let id: string | null = null;
  try {
    id = localStorage.getItem("gn_device_id");
    if (id && UUID_REGEX.test(id.trim())) return id.trim().toLowerCase();
  } catch {}
  try {
    const match = document.cookie.match(/(?:^|;\s*)gn_device_id=([^;]+)/);
    if (match && match[1]) {
      const decoded = decodeURIComponent(match[1]).trim();
      if (UUID_REGEX.test(decoded)) {
        try { localStorage.setItem("gn_device_id", decoded.toLowerCase()); } catch {}
        return decoded.toLowerCase();
      }
    }
  } catch {}
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    id = crypto.randomUUID();
  } else {
    id = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  try { localStorage.setItem("gn_device_id", id); } catch {}
  try { document.cookie = "gn_device_id=" + encodeURIComponent(id) + "; max-age=31536000; path=/; SameSite=Lax"; } catch {}
  return id;
}

export function saveDeviceId(id: string) {
  if (typeof window === "undefined" || !id) return;
  const clean = id.trim();
  try { localStorage.setItem("gn_device_id", clean); } catch {}
  try { document.cookie = "gn_device_id=" + encodeURIComponent(clean) + "; max-age=31536000; path=/; SameSite=Lax"; } catch {}
}

export function getRunningAppVersion(): string {
  if (typeof window === "undefined") return APP_VERSION;
  try {
    const saved = localStorage.getItem(KEYS.appVersion);
    if (saved && saved.trim()) return saved.trim();
  } catch {}
  return APP_VERSION;
}

export function setRunningAppVersion(ver: string) {
  if (typeof window !== "undefined" && ver?.trim()) {
    try {
      localStorage.setItem(KEYS.appVersion, ver.trim());
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.appVersion }));
    } catch {}
  }
}

export function useAppVersion() {
  const [ver, setVer] = useState<string>(getRunningAppVersion);
  useEffect(() => {
    setVer(getRunningAppVersion());
    const on = (e: Event) => {
      const k = (e as CustomEvent).detail ?? (e as StorageEvent).key;
      if (k === KEYS.appVersion) setVer(getRunningAppVersion());
    };
    window.addEventListener("gn-store", on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener("gn-store", on);
      window.removeEventListener("storage", on);
    };
  }, []);

  const update = useCallback((newVer: string) => {
    setRunningAppVersion(newVer);
    setVer(newVer);
  }, []);

  return [ver, update] as const;
}

export function getBeepAlertsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const v = localStorage.getItem(KEYS.beepAlerts);
    if (v !== null) return JSON.parse(v);
  } catch {}
  return true;
}

export function setBeepAlertsEnabled(enabled: boolean) {
  if (typeof window !== "undefined") {
    try {
      localStorage.setItem(KEYS.beepAlerts, JSON.stringify(enabled));
      window.dispatchEvent(new CustomEvent("gn-store", { detail: KEYS.beepAlerts }));
    } catch {}
  }
}

export function useBeepAlerts() {
  return useStored<boolean>(KEYS.beepAlerts, true);
}

export function useServiceStatus() {
  return useStored<ServiceStatus>(KEYS.serviceStatus, defaultServiceStatus);
}

export function useExemptedNumbers() {
  return useStored<ExemptedNumber[]>(KEYS.exemptedNumbers, []);
}

export function useOffers() {
  return useStored<PassOffer[]>(KEYS.offers, [..._DP]);
}

export function useBlockedNumbers() {
  return useStored<BlockedNumber[]>(KEYS.blockedNumbers, []);
}



export function getPersistedPhone(): string {
  if (typeof window === "undefined") return "";
  try {
    const fromLocal = localStorage.getItem("gn_saved_phone");
    if (fromLocal && fromLocal.trim()) return fromLocal.trim();
  } catch {}
  try {
    const match = document.cookie.match(/(?:^|;\s*)gn_saved_phone=([^;]+)/);
    if (match && match[1]) return decodeURIComponent(match[1]);
  } catch {}
  return "";
}

export function savePersistedPhone(phone: string) {
  if (typeof window === "undefined" || !phone) return;
  const clean = phone.trim();
  try {
    localStorage.setItem("gn_saved_phone", clean);
  } catch {}
  try {
    document.cookie = "gn_saved_phone=" + encodeURIComponent(clean) + "; max-age=31536000; path=/; SameSite=Lax";
  } catch {}
}
