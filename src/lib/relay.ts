export const DIRECT_NETWORK_NAME = "DIRECT-GLOBAL-NETWORKS";
export type MeshLink = {
  id: string; groupOwner: string; clients: string[]; networkName: string;
  source: "native" | "simulated"; connected: boolean; transportReady: boolean;
  upstreamInPool: boolean; updatedAt: number; sentBytes: number; receivedBytes: number;
};
export function relayProvidesConnection(link: MeshLink | null | undefined, now: number) {
  return Boolean(link?.connected && link.transportReady && link.upstreamInPool && now - link.updatedAt < 30_000);
}