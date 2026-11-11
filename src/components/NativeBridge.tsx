import { toast } from 'sonner';
import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { GlobalRelay, type NativeState } from '@/lib/native-relay';
import { KEYS, defaultDevice, read, write, useStored, useBeepAlerts, recordNetworkAlert, type Session, type Network, type Device } from '@/lib/store';
import { saveShared } from '@/lib/cloud-cache';
import { connectionState } from '@/lib/rules';

export function NativeBridge() {
  const [sessions] = useStored<Session[]>(KEYS.sessions, []);
  const [networks] = useStored<Network[]>(KEYS.networks, []);
  const sessionRef = useRef(sessions);
  const poolRef = useRef(networks);
  const [beepAlerts] = useBeepAlerts();
  const beepRef = useRef(beepAlerts);
  beepRef.current = beepAlerts;
  sessionRef.current = sessions;
  poolRef.current = networks;

  const getWatcherConfig = (currSessions: Session[], currNetworks: Network[]) => {
    const hasActivePass = currSessions.some((s) => s.remainingMs > 0 && !s.frozen);
    const poolSsids = currNetworks.map((n) => n.ssid).filter(Boolean);
    const poolBssids = currNetworks.map((n) => n.bssid).filter(Boolean);
    const poolPasswords: Record<string, string> = {};
    currNetworks.forEach((n) => {
      if (n.ssid && n.password) {
        poolPasswords[n.ssid.trim().toLowerCase()] = n.password;
      }
    });
    return { poolSsids, poolBssids, hasActivePass, soundAlerts: beepRef.current, poolPasswords };
  };

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    let lastMeshSync = 0;

    // Trigger mandatory runtime & VPN permissions right on launch
    void GlobalRelay.requestAccess().catch(() => {});
    void GlobalRelay.checkMandatoryPermission().catch(() => {});

    const update = (state: NativeState) => {
      if (disposed) return;
      try {
        const previous = read<Device>(KEYS.device, defaultDevice);
        write(KEYS.device, {
          ...previous,
          appMode: true,
          captive: previous.currentWifi?.bssid === state.bssid ? previous.captive : null,
          perms: {
            background: state.granted ? 'granted' : 'denied',
            wifi: state.granted ? 'granted' : 'denied',
            relay: state.granted ? 'granted' : 'denied',
          },
          currentWifi: state.ssid && state.bssid ? { ssid: state.ssid, bssid: state.bssid } : null,
          relay: state.relay ?? null,
          nearbyPoolDetected: Boolean(state.nearbyPoolDetected),
          nearbySsid: state.nearbySsid ?? undefined,
          connectedDirectly: Boolean(state.connectedDirectly),
        });

        if (state.authFailedSsid) {
          const failedSsid = state.authFailedSsid.trim();
          const matchedNet = poolRef.current.find(
            (n) => n.ssid && n.ssid.trim().toLowerCase() === failedSsid.toLowerCase()
          );
          if (matchedNet) {
            recordNetworkAlert(matchedNet.ssid, matchedNet.bssid, matchedNet.venue);
            toast.error(`Router rejected password for "${failedSsid}". Update the WPA key in admin dashboard.`, { id: 'auth_failed_' + failedSsid, duration: 6000 });
          }
          void GlobalRelay.clearAuthFailed().catch(() => {});
        }

        if (state.relay && Date.now() - lastMeshSync > 9000) {
          lastMeshSync = Date.now();
          void saveShared(KEYS.mesh, [state.relay]).catch(() => {});
        }
      } catch (err) {
        console.error('NativeBridge state update error:', err);
      }
    };

    const listener = GlobalRelay.addListener('stateChanged', update);
    void GlobalRelay.getState().then(update);

    const syncWatcher = () => {
      void GlobalRelay.syncWatcherConfig(getWatcherConfig(sessionRef.current, poolRef.current)).catch(() => {});
    };

    let isAutoRouterActive = false;

    const check = () => {
      const device = read<Device>(KEYS.device, defaultDevice);
      const active = sessionRef.current.some((s) => s.remainingMs > 0 && !s.frozen);
      const isDirect = Boolean(device.connectedDirectly);
      const state = connectionState(
        device.currentWifi,
        poolRef.current.map((n) => n.bssid),
        device.personalSsids,
        poolRef.current.map((n) => n.ssid),
        isDirect
      );
      const upstreamInPool = state === 'pool';
      const hasUpstreamWifi = Boolean(device.currentWifi?.ssid || device.currentWifi?.bssid);

      // Relay is active whenever:
      // 1) The user has an active pass (standard roaming relay)
      // 2) OR the user is connected to Wi-Fi (direct Wi-Fi or pool Wi-Fi), even with an inactive pass, acting as an uplink relay host!
      const shouldRelay = active || hasUpstreamWifi;

      if (shouldRelay) {
        void GlobalRelay.start({ active, upstreamInPool: upstreamInPool || isDirect }).catch(() => {});
        if (active && !upstreamInPool && !isDirect) {
          if (device.currentWifi) {
            if (!isAutoRouterActive) {
              isAutoRouterActive = true;
              void GlobalRelay.startClientAutoRouter().catch(() => {});
            }
          } else {
            if (isAutoRouterActive) {
              isAutoRouterActive = false;
              void GlobalRelay.stopClientAutoRouter().catch(() => {});
            }
            void GlobalRelay.triggerCompanionFallback().catch(() => {});
          }
        } else {
          if (isAutoRouterActive) {
            isAutoRouterActive = false;
            void GlobalRelay.stopClientAutoRouter().catch(() => {});
          }
        }
      } else {
        if (isAutoRouterActive) {
          isAutoRouterActive = false;
        }
        void GlobalRelay.stop().catch(() => {});
        void GlobalRelay.stopClientAutoRouter().catch(() => {});
      }

      syncWatcher();
      void GlobalRelay.getState().then(update);
    };

    check();
    const timer = setInterval(check, 10_000);

    return () => {
      disposed = true;
      clearInterval(timer);
      void listener.then((handle) => handle?.remove?.()).catch(() => {});
    };
  }, []);

  // Sync watcher config whenever sessions or networks change
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    void GlobalRelay.syncWatcherConfig(getWatcherConfig(sessions, networks)).catch(() => {});
  }, [sessions, networks]);

  return null;
}
