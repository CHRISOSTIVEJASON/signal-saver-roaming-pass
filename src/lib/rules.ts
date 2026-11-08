export const SECURITY_CODE = "2006";
export const DEFAULT_PASSCODE = "1234";

export const PASSES = [
  { id: "p15", amount: 10, hours: 15, label: "15 Hours Access", popular: false },
  { id: "p30", amount: 18, hours: 30, label: "30 Hours Access", popular: true },
] as const;
export type PassId = (typeof PASSES)[number]["id"];

export function getPass(id: string) {
  return PASSES.find((p) => p.id === id) ?? PASSES[0];
}

/** Normalises Safaricom numbers (07.. / 01.. / 2547.. / +2541..) to 2547XXXXXXXX. Returns null if invalid. */
export function normalizePhone(input: string): string | null {
  const d = input.replace(/\D/g, "");
  let local = "";
  if (/^0[17]\d{8}$/.test(d)) local = d.slice(1);
  else if (/^254[17]\d{8}$/.test(d)) local = d.slice(3);
  else if (/^[17]\d{8}$/.test(d)) local = d;
  else return null;
  return "254" + local;
}

export type PasscodeResult = { ok: true; passcode: string } | { ok: false; error: string };

/** Passcode can only be changed when the hardcoded security code is supplied. */
export function changePasscode(securityCode: string, newPasscode: string): PasscodeResult {
  if (securityCode !== SECURITY_CODE) return { ok: false, error: "Invalid security code" };
  if (!/^\S{4,}$/.test(newPasscode)) return { ok: false, error: "Passcode must be at least 4 characters" };
  return { ok: true, passcode: newPasscode };
}

/** Advance a countdown: time only drains while online. */
export function tick(remainingMs: number, lastTick: number, now: number, online: boolean) {
  if (!online) return Math.max(0, remainingMs);
  return Math.max(0, remainingMs - Math.max(0, now - lastTick));
}

export function formatClock(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export const APP_VERSION = "1.0.4";

export type WifiState = "pool" | "personal" | "searching";
/** Pool Wi-Fi drains the pass; the user's own saved Wi-Fi never does; anything else freezes it. */
export function connectionState(
  current: { ssid: string; bssid: string } | null,
  poolBssids: string[],
  personalSsids: string[],
): WifiState {
  if (!current) return "searching";
  if (poolBssids.map((b) => b.toUpperCase()).includes(current.bssid.toUpperCase())) return "pool";
  if (personalSsids.includes(current.ssid)) return "personal";
  return "searching";
}

const parts = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
/** Update blocks only when marked required AND the latest version is newer than the installed one. */
export function isUpdateRequired(installed: string, latest: string, required: boolean) {
  if (!required || !latest) return false;
  const a = parts(installed), b = parts(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return false;
}
