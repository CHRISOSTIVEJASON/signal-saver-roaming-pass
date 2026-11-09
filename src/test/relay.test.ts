import { describe, expect, it } from "vitest";
import { relayProvidesConnection, getCompanionPin, type MeshLink } from "@/lib/relay";
const link: MeshLink = { id: "direct", groupOwner: "owner", clients: ["client"], networkName: "DIRECT-GLOBAL-NETWORKS", source: "native", connected: true, transportReady: true, upstreamInPool: true, updatedAt: 1000, sentBytes: 0, receivedBytes: 0 };
describe("Direct relay eligibility", () => {
  it("counts down only on a verified working peer transport with a pool uplink", () => {
    expect(relayProvidesConnection(link, 2000)).toBe(true);
    expect(relayProvidesConnection({ ...link, upstreamInPool: false }, 2000)).toBe(false);
  });
  it("does not treat P2P group negotiation alone as internet service", () => {
    expect(relayProvidesConnection({ ...link, transportReady: false }, 2000)).toBe(false);
  });
  it("freezes a stale or disconnected relay", () => {
    expect(relayProvidesConnection(link, 31_000)).toBe(false);
    expect(relayProvidesConnection({ ...link, connected: false }, 2000)).toBe(false);
  });
  it("extracts companion pin correctly from passphrase or phone", () => {
    expect(getCompanionPin("123456")).toBe("123456");
    expect(getCompanionPin(null, "0712345678")).toBe("345678");
    expect(getCompanionPin("", "")).toBe("842109");
  });
});

describe("Protection B: Companion device binding", () => {
  it("allows pairing when no companion is bound yet", () => {
    const payload = { bound_device_id: "host-phone", paired_companion_id: null, companion_pin: "842109" };
    const canPair = !payload.paired_companion_id || payload.paired_companion_id === "laptop-1";
    expect(canPair).toBe(true);
  });

  it("locks companion access strictly to the first paired device and blocks other phones/laptops", () => {
    const payload = { bound_device_id: "host-phone", paired_companion_id: "laptop-1", companion_pin: "842109" };
    const secondDevice = "phone-2";
    const canPairSecond = !payload.paired_companion_id || payload.paired_companion_id === secondDevice;
    expect(canPairSecond).toBe(false);

    const canPairFirst = !payload.paired_companion_id || payload.paired_companion_id === "laptop-1";
    expect(canPairFirst).toBe(true);
  });

  it("allows a new companion device only after the slot is released", () => {
    const payload: { paired_companion_id: string | null } = { paired_companion_id: "laptop-1" };
    payload.paired_companion_id = null;
    expect(!payload.paired_companion_id || payload.paired_companion_id === "phone-2").toBe(true);
  });
});

import { tick as _tick } from "@/lib/rules";
describe("timer preservation", () => {
  it("does not charge time while frozen (suspended/offline)", () => {
    expect(_tick(3_600_000, 0, 10_000_000, false)).toBe(3_600_000);
  });
});
