import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { MeshLink } from './relay';
export interface NativeState { granted: boolean; ssid?: string; bssid?: string; relay?: MeshLink; }
export const GlobalRelay = registerPlugin<{
  requestAccess(): Promise<{granted:boolean}>;
  checkMandatoryPermission(): Promise<{granted:boolean; vpnPrepared:boolean; ready:boolean}>;
  openSettings(): Promise<void>;
  getState(): Promise<NativeState>;
  start(options:{active:boolean;upstreamInPool:boolean}):Promise<void>;
  stop():Promise<void>;
  submitCaptivePortal(options: { bssid: string; loginUrl: string; fields: Record<string, string> }): Promise<{ validated: boolean }>;
  addListener(event:'stateChanged', callback:(state:NativeState)=>void):Promise<PluginListenerHandle>;
}>('GlobalRelay');
