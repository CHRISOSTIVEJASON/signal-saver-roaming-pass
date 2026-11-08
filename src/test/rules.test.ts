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
    expect([getPass("p15").amount, getPass("p15").hours]).toEqual([10, 15]);
    expect([getPass("p30").amount, getPass("p30").hours]).toEqual([18, 30]);
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
