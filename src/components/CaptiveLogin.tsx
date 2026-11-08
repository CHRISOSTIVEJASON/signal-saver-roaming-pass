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
  const ssid = device.currentWifi?.ssid;

  // Multi-AP campus support: match by BSSID or SSID so roaming across routers works seamlessly
  const registered = Boolean(
    (bssid && networks.some(n => n.bssid && n.bssid.toUpperCase() === bssid.toUpperCase())) ||
    (ssid && networks.some(n => n.ssid && n.ssid.toLowerCase() === ssid.toLowerCase()))
  );

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || !registered) return;
    let disposed = false, busy = false, retryAt = 0;
    const update = (ready: boolean, required: boolean) => {
      const current = read<Device>(KEYS.device, defaultDevice);
      if (!disposed) {
        write(KEYS.device, {
          ...current,
          captive: { bssid: bssid || current.currentWifi?.bssid || '', ready, required }
        });
      }
    };

    update(false, true);

    const connect = async () => {
      if (busy || Date.now() < retryAt) return;
      busy = true;
      try {
        const login = await getLogin({ data: { sessionId, bssid: bssid || '' } });
        if (disposed) return;
        if (!login.required || !login.config) {
          update(true, false);
          retryAt = Date.now() + 30_000;
          return;
        }

        const fields = portalFields(login.config);
        const result = await GlobalRelay.submitCaptivePortal({
          bssid: bssid || '',
          ssid: ssid || '',
          loginUrl: login.config.loginUrl,
          portalUrl: login.config.loginUrl,
          voucherCode: login.config.secret,
          fields,
        });

        const isValid = Boolean(result.validated || result.success);
        update(isValid, true);
        retryAt = Date.now() + (isValid ? 60_000 : 30_000);
      } catch {
        update(false, true);
        retryAt = Date.now() + 30_000;
      } finally {
        busy = false;
      }
    };

    void connect();
    const timer = setInterval(() => { void connect(); }, 10_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [sessionId, bssid, ssid, registered, getLogin]);

  return null;
}
