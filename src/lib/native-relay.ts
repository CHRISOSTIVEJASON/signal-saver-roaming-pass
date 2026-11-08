import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MeshLink } from './relay';

export interface NativeState {
  granted: boolean;
  ssid?: string;
  bssid?: string;
  relay?: MeshLink;
  nearbyPoolDetected?: boolean;
  nearbySsid?: string;
}

export interface UpdateProgressData {
  progress: number;
  status: string;
}

export const GlobalRelay = registerPlugin<{
  requestAccess(): Promise<{ granted: boolean }>;
  checkMandatoryPermission(): Promise<{ granted: boolean; vpnPrepared: boolean; ready: boolean }>;
  openSettings(): Promise<void>;
  requestBatteryExemption(): Promise<void>;
  getState(): Promise<NativeState>;
  start(options: { active: boolean; upstreamInPool: boolean }): Promise<void>;
  stop(): Promise<void>;
  syncWatcherConfig(options: { poolSsids: string[]; poolBssids: string[]; hasActivePass: boolean }): Promise<{ success: boolean }>;
  playBeepTone(): Promise<{ success: boolean }>;
  submitCaptivePortal(options: { bssid?: string; ssid?: string; loginUrl?: string; portalUrl?: string; fields?: Record<string, string>; voucherCode?: string; phoneNumber?: string }): Promise<{ validated: boolean; success?: boolean; statusCode?: number; message?: string }>;
  installUpdate(options: { url: string }): Promise<{ success: boolean; message?: string }>;
  addListener(event: 'stateChanged', callback: (state: NativeState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'updateProgress', callback: (data: UpdateProgressData) => void): Promise<PluginListenerHandle>;
}>('GlobalRelay');
