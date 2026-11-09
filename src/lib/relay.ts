export const DIRECT_NETWORK_NAME = "DIRECT-GLOBAL-NETWORKS";
export type MeshLink = {
  id: string; groupOwner: string; clients: string[]; networkName: string;
  source: "native" | "simulated"; connected: boolean; transportReady: boolean;
  upstreamInPool: boolean; updatedAt: number; sentBytes: number; receivedBytes: number;
  passphrase?: string;
  isGroupOwner?: boolean;
  groupOwnerAddress?: string;
  peerCount?: number;
};

export function relayProvidesConnection(link: MeshLink | null | undefined, now: number) {
  return Boolean(link?.connected && link.transportReady && link.upstreamInPool && now - link.updatedAt < 30_000);
}

export function getCompanionPin(passphrase?: string | null, phone?: string): string {
  if (passphrase && passphrase.trim().length >= 4) return passphrase.trim();
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length >= 6) return digits.slice(-6);
  return "842109";
}

export function generateCompanionPin(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    const val = arr[0] ?? Math.floor(Math.random() * 900000);
    return (100000 + (val % 900000)).toString();
  }
  return Math.floor(100000 + Math.random() * 900000).toString();
}
