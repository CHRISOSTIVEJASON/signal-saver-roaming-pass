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
