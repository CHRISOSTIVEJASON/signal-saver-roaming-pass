import { useCallback, useEffect, useState } from "react";
import { DEFAULT_PASSCODE } from "./rules";

export type PayConfig = {
  apiToken: string;
  username: string;
  password: string;
  channelId: string;
  live: boolean;
  apkUrl: string;
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
};

export const defaultConfig: PayConfig = { apiToken: "", username: "", password: "", channelId: "", live: false, apkUrl: "" };

export function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function write<T>(key: string, v: T) {
  localStorage.setItem(key, JSON.stringify(v));
  window.dispatchEvent(new CustomEvent("gn-store", { detail: key }));
}

/** localStorage-backed state, read after hydration to avoid SSR mismatches. */
export function useStored<T>(key: string, fallback: T) {
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
  return [val, set] as const;
}

export const getPasscode = () => read(KEYS.passcode, DEFAULT_PASSCODE);
export const uid = () => Math.random().toString(36).slice(2, 10).toUpperCase();
