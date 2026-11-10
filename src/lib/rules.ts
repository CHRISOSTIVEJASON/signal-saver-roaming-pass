export const SECURITY_CODE = "2006";
export const DEFAULT_PASSCODE = "1234";

export type PassOffer = {
  id: string;
  amount: number;
  hours: number;
  label: string;
  popular?: boolean;
};

export const DEFAULT_PASSES: PassOffer[] = [
  { id: "p15", amount: 10, hours: 15, label: "15 Hours Access", popular: false },
  { id: "p30", amount: 18, hours: 30, label: "30 Hours Access", popular: true },
];

export const PASSES: readonly PassOffer[] = DEFAULT_PASSES;
export type PassId = string;

export function getPass(id: string, customPasses?: PassOffer[]) {
  const pool = (customPasses && customPasses.length > 0) ? customPasses : DEFAULT_PASSES;
  return (pool.find((p) => p.id === id) ?? pool[0] ?? DEFAULT_PASSES[0]) as PassOffer;
}

/** Normalises Safaricom numbers (07.. / 01.. / 2547.. / +2541..) to 2547XXXXXXXX. Returns null if invalid. */
export function normalizePhone(input?: string | null): string | null {
  if (!input || typeof input !== "string") return null;
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

export function formatClock(ms?: number | null) {
  if (typeof ms !== "number" || isNaN(ms) || ms <= 0) return "00:00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

export const APP_VERSION = "1.2.4";

export type WifiState = "pool" | "personal" | "searching";
/** Pool Wi-Fi drains the pass; the user's own saved Wi-Fi never does; anything else freezes it. */
export function connectionState(
  current: { ssid?: string | null; bssid?: string | null } | null,
  poolBssids: string[],
  personalSsids: string[],
  poolSsids?: string[],
): WifiState {
  if (!current) return "searching";
  const currentBssid = current.bssid ? current.bssid.toUpperCase().trim() : "";
  const currentSsid = current.ssid ? current.ssid.toLowerCase().trim() : "";

  // Match by hardware MAC (BSSID)
  if (currentBssid && Array.isArray(poolBssids) && poolBssids.some((b) => b && b.toUpperCase().trim() === currentBssid)) {
    return "pool";
  }

  // Match by network name (SSID) — allows multiple access points in the same school/hotspot sharing the same name to connect
  if (currentSsid && Array.isArray(poolSsids) && poolSsids.some((s) => s && s.toLowerCase().trim() === currentSsid)) {
    return "pool";
  }

  // User's personal saved networks
  if (currentSsid && Array.isArray(personalSsids) && personalSsids.some((s) => s && s.toLowerCase().trim() === currentSsid)) {
    return "personal";
  }

  return "searching";
}

const parts = (v?: string | null) => (typeof v === "string" ? v : "").split(".").map((n) => parseInt(n, 10) || 0);
/** Update blocks only when marked required AND the latest version is newer than the installed one. */
export function isUpdateRequired(installed: string, latest: string, required: boolean) {
  if (!required || !latest) return false;
  const a = parts(installed), b = parts(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) > (a[i] ?? 0);
  }
  return false;
}

export const ALERT_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

/** Checks if the 20-minute notification & tone cooldown has elapsed */
export function shouldAlertNetwork(lastAlertTime: number, now: number, cooldownMs = ALERT_COOLDOWN_MS): boolean {
  if (!lastAlertTime || lastAlertTime <= 0) return true;
  return now - lastAlertTime >= cooldownMs;
}

/**
 * Evaluates whether an explicit Mobile Data prompt should be shown.
 * When the user has an active connection (online === true and no network failure),
 * we return false so the UI proceeds directly without showing redundant mobile data notices.
 * When offline or when the payment fetch failed due to connectivity, we return true to guide the user.
 */
export function shouldPromptMobileData(isOnline: boolean, failedDueToNetwork = false): boolean {
  return !isOnline || failedDueToNetwork;
}

export const MANUAL_PAYBILL = "756756";
export const MANUAL_ACCOUNT = "553125#13205";

export type ProportionalDuration = {
  isUnderpaid: boolean;
  minAmount: number;
  totalMs: number;
  hours: number;
  passId: string;
  rateHoursPerKes: number;
};

/**
 * Calculates pass duration proportionally for any payment amount:
 * - If amount < minAmount (underpayment): records as underpaid, grants 0 ms (no internet).
 * - If amount matches an exact pass offer: grants exact pass hours.
 * - If amount is an extra amount or any amount >= minAmount: calculates proportional duration
 *   based on the qualified tier rate and rounds to the nearest second/minute for the countdown timer.
 */
export function calculateProportionalDuration(
  amount: number,
  customPasses?: PassOffer[],
  preferredPassId?: string
): ProportionalDuration {
  const pool = customPasses && customPasses.length > 0 ? customPasses : DEFAULT_PASSES;
  const sorted = [...pool].sort((a, b) => a.amount - b.amount);
  const fallback = DEFAULT_PASSES[0]!;
  const minOffer = sorted[0] ?? fallback;
  const minAmount = minOffer.amount;

  if (amount <= 0 || amount < minAmount) {
    return {
      isUnderpaid: true,
      minAmount,
      totalMs: 0,
      hours: 0,
      passId: preferredPassId || minOffer.id,
      rateHoursPerKes: 0,
    };
  }

  const exact = pool.find((p) => p.amount === amount);
  if (exact) {
    const totalMs = Math.round(exact.hours * 3600) * 1000;
    return {
      isUnderpaid: false,
      minAmount,
      totalMs,
      hours: exact.hours,
      passId: exact.id,
      rateHoursPerKes: exact.hours / exact.amount,
    };
  }

  let baseTier: PassOffer = sorted[0] ?? fallback;
  for (const tier of sorted) {
    if (amount >= tier.amount) {
      baseTier = tier;
    }
  }

  const rate = baseTier.hours / baseTier.amount;
  const rawHours = amount * rate;
  const totalSeconds = Math.round(rawHours * 3600);
  const totalMs = totalSeconds * 1000;
  const roundedHours = Number((totalSeconds / 3600).toFixed(4));

  return {
    isUnderpaid: false,
    minAmount,
    totalMs,
    hours: roundedHours,
    passId: baseTier.id,
    rateHoursPerKes: rate,
  };
}


const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ensureUuid(val?: string | null): string {
  if (!val) {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  const trimmed = String(val).trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
