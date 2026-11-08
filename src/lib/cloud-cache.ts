import { useSyncExternalStore } from "react";

const shared = new Set(["gn_networks", "gn_sessions", "gn_txns", "gn_payhero", "gn_mesh_links"]);
const values = new Map<string, unknown>();
const listeners = new Set<() => void>();
let saver: ((key: string, value: unknown) => Promise<void>) | undefined;
export const isSharedKey = (key: string) => shared.has(key);
export function cached<T>(key: string, fallback: T): T { return (values.get(key) as T | undefined) ?? fallback; }
export function publishCache(key: string, value: unknown) {
  values.set(key, value);
  listeners.forEach((listener) => listener());
}
export function clearPrivateCache() {
  for (const key of ["gn_sessions", "gn_txns", "gn_mesh_links"]) publishCache(key, []);
}
export function registerCloudSaver(save: typeof saver) { saver = save; }
export async function saveShared(key: string, value: unknown) {
  if (!saver) throw new Error("Cloud is still connecting. Please try again.");
  await saver(key, value);
}
export function useCached<T>(key: string, fallback: T) {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => cached(key, fallback), () => fallback);
}