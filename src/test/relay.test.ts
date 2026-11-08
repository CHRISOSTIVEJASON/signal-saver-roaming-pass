import { describe, expect, it } from "vitest";
import { relayProvidesConnection, type MeshLink } from "@/lib/relay";
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
});