import { useSyncExternalStore } from "react";

const shared = new Set(["gn_networks", "gn_sessions", "gn_txns", "gn_payhero", "gn_mesh_links", "gn_network_alerts"]);
const values = new Map<string, unknown>();
const emptyList: unknown[] = [];
const defaults = new Map<string, unknown>();
const listeners = new Set<() => void>();
let saver: ((key: string, value: unknown) => Promise<void>) | undefined;
export const isSharedKey = (key: string) => shared.has(key);
export function cached<T>(key: string, fallback: T): T {
  if (values.has(key)) {
    return values.get(key) as T;
  }
  if (typeof window !== "undefined") {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) {
        const parsed = JSON.parse(v);
        values.set(key, parsed);
        return parsed as T;
      }
    } catch {}
  }
  return fallback;
}
export function publishCache(key: string, value: unknown) {
  values.set(key, value);
  listeners.forEach((listener) => listener());
}
export function clearPrivateCache() {
  // Never wipe local device sessions or transactions when unauthenticated!
  publishCache("gn_mesh_links", []);
}
export function registerCloudSaver(save: typeof saver) { saver = save; }
export async function saveShared(key: string, value: unknown) {
  if (!saver) throw new Error("Cloud is still connecting. Please try again.");
  await saver(key, value);
}
export function useCached<T>(key: string, fallback: T) {
  if (!defaults.has(key)) defaults.set(key, Array.isArray(fallback) ? emptyList : fallback);
  const stableFallback = defaults.get(key) as T;
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => cached(key, stableFallback), () => stableFallback);
}