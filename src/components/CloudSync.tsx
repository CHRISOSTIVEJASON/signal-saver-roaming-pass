import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { supabase } from '@/integrations/supabase/client';
import { publishCache, clearPrivateCache, registerCloudSaver } from '@/lib/cloud-cache';
import { defaultConfig, KEYS, read, type Session, type Txn, type Network, type PayConfig } from '@/lib/store';
import { savePaymentConfig, syncCloudNetworks, getCloudNetworks, getServiceStatus, getExemptedNumbers, getCloudOffers, getPoolNetworkPasswords } from '@/lib/cloud.functions';
import { getDeviceId } from '@/lib/store';
import { write, defaultServiceStatus, DEFAULT_PASSES } from '@/lib/store';
import type { MeshLink } from '@/lib/relay';

export function CloudSync() {
  const saveConfig = useServerFn(savePaymentConfig);
  const syncNetworks = useServerFn(syncCloudNetworks);
  const fetchNetworks = useServerFn(getCloudNetworks);
  const fetchServiceStatus = useServerFn(getServiceStatus);
  const fetchExempted = useServerFn(getExemptedNumbers);
  const fetchOffers = useServerFn(getCloudOffers);
  const fetchPoolPasswords = useServerFn(getPoolNetworkPasswords);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      let remoteNets: Network[] = [];
      try {
        const cloudNets = await fetchNetworks();
        if (cloudNets && Array.isArray(cloudNets)) {
          remoteNets = cloudNets as Network[];
        }
      } catch {
        const pool = await supabase.from('gn_networks').select('*');
        if (pool.data) {
          remoteNets = pool.data.map((n) => ({
            id: n.id,
            ssid: n.ssid,
            bssid: n.bssid,
            venue: n.venue,
            addedAt: n.added_at
          }));
        }
      }

      const settings = await supabase.from('gn_settings').select('*').eq('id', 'global').maybeSingle();
      if (disposed) return;

      // Fetch global service status (kill switch), exempted numbers, and dynamic offers
      try {
        const sStatus = await fetchServiceStatus();
        if (sStatus && typeof sStatus.active === 'boolean') {
          write(KEYS.serviceStatus, sStatus);
        }
      } catch {}

      try {
        const cloudOffers = await fetchOffers();
        if (cloudOffers && Array.isArray(cloudOffers) && cloudOffers.length > 0) {
          write(KEYS.offers, cloudOffers);
        }
      } catch {}

      try {
        const exList = await fetchExempted();
        if (exList && Array.isArray(exList)) {
          write(KEYS.exemptedNumbers, exList);
        }
      } catch {}

      // Preserve locally stamped networks and merge with cloud pool so nothing is lost!
      const localNets = read<Network[]>(KEYS.networks, []);
      // Deduplicate strictly by BSSID — preserve local router passwords!
      const netMap = new Map<string, Network>();
      for (const n of localNets) {
        if (n && n.bssid) netMap.set(n.bssid.trim().toUpperCase(), n);
      }
      for (const n of remoteNets) {
        if (n && n.bssid) {
          const key = n.bssid.trim().toUpperCase();
          const existing = netMap.get(key);
          netMap.set(key, {
            ...n,
            password: existing?.password || n.password || undefined,
          });
        }
      }

      // If active session exists, sync passwords for pool routers
      const activeSession = read<Session | null>(KEYS.active, null);
      if (activeSession && activeSession.remainingMs > 0) {
        try {
          const passMap = await fetchPoolPasswords({ data: { sessionId: activeSession.id, deviceId: getDeviceId() } });
          if (passMap && typeof passMap === 'object') {
            for (const [key, pass] of Object.entries(passMap)) {
              if (pass && typeof pass === 'string') {
                const norm = key.toUpperCase();
                const item = netMap.get(norm);
                if (item) {
                  netMap.set(norm, { ...item, password: pass });
                } else {
                  // Check matching by SSID
                  for (const [bssidKey, netObj] of netMap.entries()) {
                    if (netObj.ssid && netObj.ssid.trim().toLowerCase() === key.toLowerCase()) {
                      netMap.set(bssidKey, { ...netObj, password: pass });
                    }
                  }
                }
              }
            }
          }
        } catch {}
      }

      publishCache(KEYS.networks, Array.from(netMap.values()));

      // Preserve local PayHero credentials so they remain displayed on the dashboard!
      const localCfg = read<PayConfig>(KEYS.config, defaultConfig);
      publishCache(KEYS.config, {
        ...defaultConfig,
        ...localCfg,
        apkUrl: settings.data?.apk_url ?? localCfg.apkUrl,
        latestVersion: settings.data?.latest_version ?? localCfg.latestVersion,
        updateRequired: settings.data?.update_required ?? localCfg.updateRequired,
        live: (settings.data?.live !== undefined && settings.data?.live !== null) ? Boolean(settings.data.live) : Boolean(localCfg.live)
      });

      if (!user) { return; }
      const [sessions, txns, mesh] = await Promise.all([
        supabase.from('gn_sessions').select('*').order('updated_at', { ascending: false }),
        supabase.from('gn_transactions').select('*').order('created_at', { ascending: false }),
        supabase.from('gn_mesh_links').select('*').order('updated_at', { ascending: false })
      ]);
      if (disposed) return;
      if (sessions.data) publishCache(KEYS.sessions, sessions.data.map((s) => s.payload as unknown as Session));
      if (txns.data) publishCache(KEYS.txns, txns.data.map((t) => t.payload as unknown as Txn));
      if (mesh.data) publishCache(KEYS.mesh, mesh.data.map((m) => m.payload as unknown as MeshLink));
    };

    registerCloudSaver(async (key, value) => {
      if (key === KEYS.config) {
        await saveConfig({ data: value as PayConfig });
      } else if (key === KEYS.networks) {
        const nets = value as Network[];
        if (nets.length) {
          try {
            await syncNetworks({ data: { networks: nets } });
          } catch (err) {
            console.warn('Network cloud sync warning:', err);
          }
        }
      } else if (key === KEYS.mesh) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const links = value as MeshLink[];
          await supabase.from('gn_mesh_links').upsert(
            links.map((l) => ({
              id: l.id,
              user_id: user.id,
              payload: JSON.parse(JSON.stringify(l)),
              updated_at: new Date().toISOString()
            }))
          );
        }
      }
      await refresh();
    });

    void refresh();
    const channel = supabase.channel(`gn-sync-${crypto.randomUUID()}`).on('postgres_changes', { event: '*', schema: 'public' }, () => { void refresh(); }).subscribe();
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clearPrivateCache();
      if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(event)) setTimeout(() => { void refresh(); }, 0);
    });
    const pollTimer = setInterval(() => { void refresh(); }, 20000);
    return () => { disposed = true; clearInterval(pollTimer); registerCloudSaver(undefined); void supabase.removeChannel(channel); auth.subscription.unsubscribe(); };
  }, [saveConfig, syncNetworks, fetchNetworks, fetchServiceStatus, fetchExempted, fetchOffers]);
  return null;
}

export function useCloudIdentity() {
  const [identity, setIdentity] = useState<{ signedIn: boolean; admin: boolean }>({ signedIn: false, admin: false });
  useEffect(() => {
    const update = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setIdentity({ signedIn: false, admin: false }); return; }
      const { data } = await supabase.rpc('has_role', { _user_id: user.id, _role: 'admin' });
      setIdentity({ signedIn: true, admin: Boolean(data) });
    };
    void update();
    const { data } = supabase.auth.onAuthStateChange((event) => { if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED'].includes(event)) setTimeout(() => { void update(); }, 0); });
    return () => data.subscription.unsubscribe();
  }, []);
  return identity;
}
