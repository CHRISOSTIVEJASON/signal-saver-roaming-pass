import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { supabase } from '@/integrations/supabase/client';
import { publishCache, clearPrivateCache, registerCloudSaver } from '@/lib/cloud-cache';
import { defaultConfig, KEYS, type Session, type Txn, type Network, type PayConfig } from '@/lib/store';
import { savePaymentConfig } from '@/lib/cloud.functions';
import type { MeshLink } from '@/lib/relay';
import { toast } from 'sonner';

export function CloudSync() {
  const saveConfig = useServerFn(savePaymentConfig);
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const [pool, settings] = await Promise.all([supabase.from('gn_networks').select('*'), supabase.from('gn_settings').select('*').eq('id','global').maybeSingle()]);
      if (disposed) return;
      if (pool.error || settings.error) { toast.error('Shared records could not be loaded'); return; }
      publishCache(KEYS.networks, pool.data.map((n) => ({ id:n.id, ssid:n.ssid,bssid:n.bssid,venue:n.venue,addedAt:n.added_at })));
      publishCache(KEYS.config, { ...defaultConfig, apkUrl:settings.data?.apk_url ?? '', latestVersion:settings.data?.latest_version ?? '1.0.0', updateRequired:settings.data?.update_required ?? false, live:settings.data?.live ?? false });
      if (!user) { clearPrivateCache(); return; }
      const [sessions, txns, mesh] = await Promise.all([supabase.from('gn_sessions').select('*').order('updated_at',{ascending:false}),supabase.from('gn_transactions').select('*').order('created_at',{ascending:false}),supabase.from('gn_mesh_links').select('*').order('updated_at',{ascending:false})]);
      if (disposed) return;
      if (sessions.error || txns.error || mesh.error) { toast.error('Your Cloud records could not be loaded'); return; }
      publishCache(KEYS.sessions, sessions.data.map((s) => s.payload as unknown as Session));
      publishCache(KEYS.txns, txns.data.map((t) => t.payload as unknown as Txn));
      publishCache(KEYS.mesh, mesh.data.map((m) => m.payload as unknown as MeshLink));
    };
    registerCloudSaver(async (key, value) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Sign in to save shared records');
      if (key === KEYS.config) await saveConfig({ data: value as PayConfig });
      else if (key === KEYS.networks) {
        const { data: admin } = await supabase.rpc('has_role',{_user_id:user.id,_role:'admin'});
        if (!admin) throw new Error('Administrator access required');
        const nets = value as Network[];
        const { data: existing, error: readError } = await supabase.from('gn_networks').select('id');
        if (readError) throw readError;
        const removed = existing.filter((n) => !nets.some((next) => next.id === n.id)).map((n) => n.id);
        if (removed.length) { const { error } = await supabase.from('gn_networks').delete().in('id', removed); if (error) throw error; }
        if (nets.length) { const { error } = await supabase.from('gn_networks').upsert(nets.map((n) => ({id:n.id,ssid:n.ssid,bssid:n.bssid,venue:n.venue,added_at:n.addedAt}))); if(error) throw error; }
      } else if (key === KEYS.mesh) {
        const links = value as MeshLink[];
        const { error } = await supabase.from('gn_mesh_links').upsert(links.map((l) => ({id:l.id,user_id:user.id,payload:JSON.parse(JSON.stringify(l)),updated_at:new Date().toISOString()})));
        if (error) throw error;
      } else throw new Error('Passes and payments can only be changed by verified payment processing');
      await refresh();
    });
    void refresh();
    const channel = supabase.channel(`gn-sync-${crypto.randomUUID()}`).on('postgres_changes',{event:'*',schema:'public'},() => { void refresh(); }).subscribe();
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') clearPrivateCache();
      if (['SIGNED_IN','SIGNED_OUT','USER_UPDATED'].includes(event)) setTimeout(() => { void refresh(); },0);
    });
    return () => { disposed = true; registerCloudSaver(undefined); void supabase.removeChannel(channel); auth.subscription.unsubscribe(); };
  }, [saveConfig]);
  return null;
}

export function useCloudIdentity() {
  const [identity, setIdentity] = useState<{ signedIn: boolean; admin: boolean }>({signedIn:false,admin:false});
  useEffect(() => {
    const update = async () => {
      const { data:{user} } = await supabase.auth.getUser();
      if (!user) { setIdentity({signedIn:false,admin:false}); return; }
      const { data } = await supabase.rpc('has_role',{_user_id:user.id,_role:'admin'});
      setIdentity({signedIn:true,admin:Boolean(data)});
    };
    void update();
    const { data } = supabase.auth.onAuthStateChange((event) => { if(['SIGNED_IN','SIGNED_OUT','USER_UPDATED'].includes(event)) setTimeout(() => { void update(); },0); });
    return () => data.subscription.unsubscribe();
  },[]);
  return identity;
}
