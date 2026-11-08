import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { useServerFn } from '@tanstack/react-start';
import { getPaidCaptive } from '@/lib/captive.functions';
import { portalFields } from '@/lib/captive';
import { GlobalRelay } from '@/lib/native-relay';
import { KEYS, read, write, defaultDevice, useStored, type Device, type Network } from '@/lib/store';

export function CaptiveLogin({ sessionId }: { sessionId: string }) {
  const getLogin = useServerFn(getPaidCaptive);
  const [device] = useStored<Device>(KEYS.device, defaultDevice);
  const [networks] = useStored<Network[]>(KEYS.networks, []);
  const bssid = device.currentWifi?.bssid;
  const registered = Boolean(bssid && networks.some(n => n.bssid.toUpperCase() === bssid.toUpperCase()));
  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !bssid || !registered) return;
    let disposed = false, busy = false, retryAt = 0;
    const update = (ready: boolean, required: boolean) => {
      const current = read<Device>(KEYS.device, defaultDevice);
      if (!disposed && current.currentWifi?.bssid === bssid) write(KEYS.device, { ...current, captive: { bssid, ready, required } });
    };
    update(false, true);
    const connect = async () => {
      if (busy || Date.now() < retryAt) return;
      busy = true;
      try {
        const login = await getLogin({ data: { sessionId, bssid } });
        if (disposed) return;
        if (!login.required || !login.config) { update(true, false); retryAt = Date.now() + 30_000; return; }
        const result = await GlobalRelay.submitCaptivePortal({ bssid, loginUrl: login.config.loginUrl, fields: portalFields(login.config) });
        update(result.validated, true);
        retryAt = Date.now() + (result.validated ? 60_000 : 30_000);
      } catch { update(false, true); retryAt = Date.now() + 30_000; }
      finally { busy = false; }
    };
    void connect();
    const timer = setInterval(() => { void connect(); }, 10_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [sessionId, bssid, registered, getLogin]);
  return null;
}