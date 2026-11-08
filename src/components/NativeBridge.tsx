import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { GlobalRelay, type NativeState } from '@/lib/native-relay';
import { KEYS, defaultDevice, read, write, useStored, type Session, type Network, type Device } from '@/lib/store';
import { saveShared } from '@/lib/cloud-cache';
import { connectionState } from '@/lib/rules';
export function NativeBridge() {
  const [sessions] = useStored<Session[]>(KEYS.sessions, []);
  const [networks] = useStored<Network[]>(KEYS.networks, []);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed=false;
    const update = (state: NativeState) => {
      if(disposed)return;
      const previous=read<Device>(KEYS.device,defaultDevice);
      write(KEYS.device,{...previous,appMode:true,perms:{background:state.granted?'granted':'denied',wifi:state.granted?'granted':'denied',relay:state.granted?'granted':'denied'},currentWifi:state.ssid && state.bssid ? {ssid:state.ssid,bssid:state.bssid}:null,relay:state.relay??null});
      if(state.relay) void saveShared(KEYS.mesh,[state.relay]).catch(()=>{});
    };
    const listener=GlobalRelay.addListener('stateChanged',update);
    void GlobalRelay.getState().then(update);
    const device=read<Device>(KEYS.device,defaultDevice);
    const active=sessions.some(s=>s.remainingMs>0);
    const upstreamInPool=connectionState(device.currentWifi,networks.map(n=>n.bssid),device.personalSsids)==='pool';
    if(active) void GlobalRelay.start({active,upstreamInPool}).catch(()=>{}); else void GlobalRelay.stop().catch(()=>{});
    const timer=setInterval(()=>{void GlobalRelay.getState().then(update);},10_000);
    return ()=>{disposed=true;clearInterval(timer);void listener.then(handle=>handle.remove());};
  },[sessions,networks]);
  return null;
}
