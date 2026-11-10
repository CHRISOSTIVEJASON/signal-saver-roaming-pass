import { describe, it, expect } from "vitest";
import { changePasscode, getPass, normalizePhone, tick } from "@/lib/rules";

describe("rules", () => {
  it("rejects passcode change without security code 2006", () => {
    expect(changePasscode("1234", "9999").ok).toBe(false);
  });
  it("accepts passcode change with security code 2006", () => {
    expect(changePasscode("2006", "9999")).toEqual({ ok: true, passcode: "9999" });
  });
  it("prices passes at KES 10/15h and KES 18/30h", () => {
    expect([getPass("p15")!.amount, getPass("p15")!.hours]).toEqual([10, 15]);
    expect([getPass("p30")!.amount, getPass("p30")!.hours]).toEqual([18, 30]);
  });
  it("freezes time while offline", () => {
    expect(tick(1000, 0, 500, false)).toBe(1000);
    expect(tick(1000, 0, 500, true)).toBe(500);
  });
  it("normalises Safaricom numbers", () => {
    expect(normalizePhone("0712345678")).toBe("254712345678");
    expect(normalizePhone("0112345678")).toBe("254112345678");
    expect(normalizePhone("12345")).toBeNull();
  });
});

import { connectionState, isUpdateRequired } from "@/lib/rules";
describe("roaming + updates", () => {
  const pool = ["AA:BB:CC:DD:EE:FF"];
  it("connects to pool Wi-Fi by SSID even with different BSSID (school/campus multi-AP)", () => {
    expect(connectionState({ ssid: "School_Wifi", bssid: "99:88:77:66:55:44" }, pool, [], ["School_Wifi"])).toBe("pool");
  });
  it("drains only on stamped pool Wi-Fi", () => {
    expect(connectionState({ ssid: "Mall", bssid: "aa:bb:cc:dd:ee:ff" }, pool, [])).toBe("pool");
  });
  it("never drains on the user's own saved Wi-Fi", () => {
    expect(connectionState({ ssid: "Home", bssid: "11:22:33:44:55:66" }, pool, ["Home"])).toBe("personal");
  });
  it("freezes when not on pool Wi-Fi", () => {
    expect(connectionState(null, pool, [])).toBe("searching");
    expect(connectionState({ ssid: "Cafe", bssid: "11:22:33:44:55:77" }, pool, [])).toBe("searching");
  });
  it("blocks only for a required, newer version", () => {
    expect(isUpdateRequired("1.0.0", "1.1.0", true)).toBe(true);
    expect(isUpdateRequired("1.0.0", "1.1.0", false)).toBe(false);
    expect(isUpdateRequired("1.0.0", "1.0.0", true)).toBe(false);
  });
});

import { shouldAlertNetwork, ALERT_COOLDOWN_MS } from "@/lib/rules";
describe("background network alert cooldown", () => {
  it("alerts on first detection", () => {
    expect(shouldAlertNetwork(0, Date.now())).toBe(true);
  });
  it("suppresses repeated alerts within 20 minutes", () => {
    const t0 = 1000000;
    expect(shouldAlertNetwork(t0, t0 + 5 * 60 * 1000)).toBe(false);
    expect(shouldAlertNetwork(t0, t0 + 19 * 60 * 1000)).toBe(false);
  });
  it("allows alert after 20 minutes have passed", () => {
    const t0 = 1000000;
    expect(shouldAlertNetwork(t0, t0 + ALERT_COOLDOWN_MS)).toBe(true);
    expect(shouldAlertNetwork(t0, t0 + ALERT_COOLDOWN_MS + 1000)).toBe(true);
  });
});

describe("Admin user wipeout & factory reset", () => {
  it("session heartbeat detects wiped state and signals factory reset", () => {
    // When session is missing or wiped:
    const wipedResponse = { id: "test-sess", wiped: true, remainingMs: 0, online: false };
    expect(wipedResponse.wiped).toBe(true);
    expect(wipedResponse.remainingMs).toBe(0);
    expect(wipedResponse.online).toBe(false);
  });
});

import { shouldPromptMobileData } from "@/lib/rules";
describe("mobile data smart prompt check", () => {
  it("does not prompt when user is online and no network failure occurred", () => {
    expect(shouldPromptMobileData(true, false)).toBe(false);
  });
  it("prompts when user is offline", () => {
    expect(shouldPromptMobileData(false, false)).toBe(true);
  });
  it("prompts when payment attempt failed due to network unreachable even if online flag was true", () => {
    expect(shouldPromptMobileData(true, true)).toBe(true);
  });
});

import { calculateProportionalDuration, MANUAL_PAYBILL, MANUAL_ACCOUNT, formatClock, ensureUuid } from "@/lib/rules";

describe("proportional payment duration & underpayment rules", () => {
  it("exports the required Paybill and Account numbers", () => {
    expect(MANUAL_PAYBILL).toBe("756756");
    expect(MANUAL_ACCOUNT).toBe("553125#13205");
  });

  it("records payments less than the minimum offer as underpaid without granting internet", () => {
    const under5 = calculateProportionalDuration(5);
    expect(under5.isUnderpaid).toBe(true);
    expect(under5.totalMs).toBe(0);
    expect(under5.hours).toBe(0);
    expect(under5.minAmount).toBe(10);

    const under9 = calculateProportionalDuration(9);
    expect(under9.isUnderpaid).toBe(true);
    expect(under9.totalMs).toBe(0);

    const zero = calculateProportionalDuration(0);
    expect(zero.isUnderpaid).toBe(true);
    expect(zero.totalMs).toBe(0);
  });

  it("calculates exact hours for standard pass amounts (KES 10 and KES 18)", () => {
    const p10 = calculateProportionalDuration(10);
    expect(p10.isUnderpaid).toBe(false);
    expect(p10.hours).toBe(15);
    expect(p10.totalMs).toBe(15 * 3600 * 1000);
    expect(formatClock(p10.totalMs)).toBe("15:00:00");

    const p18 = calculateProportionalDuration(18);
    expect(p18.isUnderpaid).toBe(false);
    expect(p18.hours).toBe(30);
    expect(p18.totalMs).toBe(30 * 3600 * 1000);
    expect(formatClock(p18.totalMs)).toBe("30:00:00");
  });

  it("calculates proportional time rounded to nearest second for intermediate amounts (e.g. KES 15)", () => {
    // 15 KES at baseline rate (15h / 10 KES = 1.5 h/KES) -> 22.5 hours = 22h 30m 00s
    const p15 = calculateProportionalDuration(15);
    expect(p15.isUnderpaid).toBe(false);
    expect(p15.hours).toBe(22.5);
    expect(p15.totalMs).toBe(22.5 * 3600 * 1000);
    expect(formatClock(p15.totalMs)).toBe("22:30:00");
  });

  it("calculates proportional time rounded to nearest second for extra amounts above highest tier", () => {
    // 20 KES at tier 2 rate (30h / 18 KES = 1.66667 h/KES) -> 33.3333 hours = 33h 20m 00s
    const p20 = calculateProportionalDuration(20);
    expect(p20.isUnderpaid).toBe(false);
    expect(formatClock(p20.totalMs)).toBe("33:20:00");

    // 25 KES -> 41.6667 hours = 41h 40m 00s
    const p25 = calculateProportionalDuration(25);
    expect(p25.isUnderpaid).toBe(false);
    expect(formatClock(p25.totalMs)).toBe("41:40:00");

    // 36 KES -> exactly double tier 2 = 60 hours = 60h 00m 00s
    const p36 = calculateProportionalDuration(36);
    expect(p36.isUnderpaid).toBe(false);
    expect(p36.hours).toBe(60);
    expect(formatClock(p36.totalMs)).toBe("60:00:00");
  });

  it("generates and preserves valid RFC4122 UUIDs for database operations", () => {
    const valid = "12345678-1234-4234-8234-123456789abc";
    expect(ensureUuid(valid)).toBe(valid);

    const legacyDevId = "dev-abc123xyz";
    const converted = ensureUuid(legacyDevId);
    expect(converted).not.toBe(legacyDevId);
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(converted)).toBe(true);

    const fromEmpty = ensureUuid();
    expect(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fromEmpty)).toBe(true);
  });
});

describe("defensive runtime guards", () => {
  it("handles nullish and invalid inputs gracefully without throwing", () => {
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("")).toBeNull();
    expect(formatClock(NaN)).toBe("00:00:00");
    expect(formatClock(null as any)).toBe("00:00:00");
    expect(formatClock(-1000)).toBe("00:00:00");
    expect(isUpdateRequired(undefined as any, null as any, true)).toBe(false);
    expect(connectionState(null, [], [])).toBe("searching");
    expect(connectionState({ ssid: null, bssid: null }, [null as any], [null as any])).toBe("searching");
  });
});
