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

/**
 * Optimized MTU for Multi-Hop Wi-Fi Relays & P2P Tunnels.
 * Standard 1500 causes packet fragmentation on encapsulated P2P links.
 * 1400 prevents fragmentation and packet loss on TikTok/video streams over weak signals.
 */
export const RELAY_OPTIMAL_MTU = 1400;

/**
 * IP Quality of Service (QoS) traffic class for low-latency streaming / voice / video
 * 0x10 = IPTOS_LOWDELAY, mapped to WMM Video priority queue by Wi-Fi chipsets.
 */
export const RELAY_QOS_STREAMING_CLASS = 0x10;

export interface RelayStreamProfile {
  mtu: number;
  qosClass: number;
  bufferSize: number;
  mode: "faint_signal_boost" | "standard_relay" | "high_throughput";
  description: string;
}

export function getRelayStreamProfile(rssiDbm?: number | null): RelayStreamProfile {
  if (rssiDbm !== undefined && rssiDbm !== null && rssiDbm < -80) {
    return {
      mtu: 1380,
      qosClass: RELAY_QOS_STREAMING_CLASS,
      bufferSize: 131072,
      mode: "faint_signal_boost",
      description: "Faint signal detected: compressed MTU & prioritized low-latency queue active"
    };
  }
  return {
    mtu: RELAY_OPTIMAL_MTU,
    qosClass: RELAY_QOS_STREAMING_CLASS,
    bufferSize: 262144,
    mode: "high_throughput",
    description: "High-speed QUIC/UDP streaming mode active (zero packet fragmentation)"
  };
}
