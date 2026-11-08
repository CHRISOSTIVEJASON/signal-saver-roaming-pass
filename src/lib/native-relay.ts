import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MeshLink } from './relay';

export interface NativeState {
  granted: boolean;
  ssid?: string;
  bssid?: string;
  relay?: MeshLink;
}

export interface UpdateProgressData {
  progress: number;
  status: string;
}

export const GlobalRelay = registerPlugin<{
  requestAccess(): Promise<{ granted: boolean }>;
  checkMandatoryPermission(): Promise<{ granted: boolean; vpnPrepared: boolean; ready: boolean }>;
  openSettings(): Promise<void>;
  getState(): Promise<NativeState>;
  start(options: { active: boolean; upstreamInPool: boolean }): Promise<void>;
  stop(): Promise<void>;
  submitCaptivePortal(options: { bssid: string; loginUrl: string; fields: Record<string, string> }): Promise<{ validated: boolean }>;
  installUpdate(options: { url: string }): Promise<{ success: boolean; message?: string }>;
  addListener(event: 'stateChanged', callback: (state: NativeState) => void): Promise<PluginListenerHandle>;
  addListener(event: 'updateProgress', callback: (data: UpdateProgressData) => void): Promise<PluginListenerHandle>;
}>('GlobalRelay');
