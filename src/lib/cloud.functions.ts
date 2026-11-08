import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { requireSupabaseAuth } from '@/integrations/supabase/auth-middleware';
import { getPass, normalizePhone, tick } from './rules';
import type { Session, Txn, PayConfig } from './store';

export const savePaymentConfig = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
.inputValidator((data: PayConfig) => data).handler(async ({ data, context }) => {
  const { data: admin } = await context.supabase.rpc('has_role', { _user_id: context.userId, _role: 'admin' });
  if (!admin) throw new Error('Administrator access required');
  if (data.apkUrl && !/^https:\/\//.test(data.apkUrl)) throw new Error('Use an HTTPS APK download link');
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  if (data.apiToken || data.username || data.password || data.channelId) {
    const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({ id: 'global', api_token: data.apiToken, username: data.username, password: data.password, channel_id: data.channelId });
    if (error) throw new Error('Unable to save payment credentials');
  }
  const { error } = await context.supabase.from('gn_settings').upsert({ id: 'global', apk_url: data.apkUrl, latest_version: data.latestVersion, update_required: data.updateRequired, live: data.live });
  if (error) throw new Error('Unable to save settings');
  return { ok: true };
});

export const startCloudPayment = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
.inputValidator((input) => z.object({ phone: z.string(), passId: z.enum(['p15', 'p30']) }).parse(input))
.handler(async ({ data, context }) => {
  const phone = normalizePhone(data.phone);
  if (!phone) throw new Error('Enter a valid M-Pesa number');
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { data: settings } = await context.supabase.from('gn_settings').select('live').eq('id', 'global').maybeSingle();
  const pass = getPass(data.passId);
  const id = crypto.randomUUID();
  let ref = 'GN' + id.replaceAll('-', '');
  const live = settings?.live ?? false;
  const txn: Txn = { id, ref, phone, amount: pass.amount, passId: pass.id, at: Date.now(), status: 'Pending', mode: live ? 'Live' : 'Demo' };
  if (live) {
    const { data: credentials } = await supabaseAdmin.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle();
    if (!credentials?.channel_id || !(credentials.api_token || (credentials.username && credentials.password))) throw new Error('Live payments are not configured yet');
    const token = credentials.api_token.trim();
    const authorization = token ? (token.toLowerCase().startsWith('basic ') ? token : `Basic ${token}`) : `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
    const response = await fetch('https://backend.payhero.co.ke/api/v2/payments', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify({ amount: pass.amount, phone_number: phone, channel_id: Number(credentials.channel_id), provider: 'm-pesa', external_reference: ref }) });
    const result = await response.json() as { reference?: string };
    if (!response.ok || !result.reference) throw new Error('M-Pesa prompt could not be sent');
    ref = result.reference; txn.ref = ref;
  }
  const { error } = await supabaseAdmin.from('gn_transactions').insert({ id, user_id: context.userId, payload: JSON.parse(JSON.stringify(txn)) });
  if (error) throw new Error('Unable to record payment');
  return { id, live };
});

export const confirmCloudPayment = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
.inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
.handler(async ({ data, context }) => {
  const { data: row } = await context.supabase.from('gn_transactions').select('*').eq('id', data.id).eq('user_id', context.userId).single();
  if (!row) throw new Error('Payment not found');
  const txn = row.payload as unknown as Txn;
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  if (txn.status === 'Failed') throw new Error('Payment failed or was cancelled');
  if (txn.mode === 'Live' && txn.status !== 'Activated') {
    const { data: c } = await supabaseAdmin.from('gn_payment_credentials').select('*').eq('id','global').single();
    if (!c) throw new Error('Payment configuration unavailable');
    const token = c.api_token.trim();
    const authorization = token ? (token.toLowerCase().startsWith('basic ') ? token : `Basic ${token}`) : `Basic ${btoa(`${c.username}:${c.password}`)}`;
    const response = await fetch(`https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(txn.ref)}`, { headers: { Authorization: authorization } });
    if (!response.ok) return { pending: true, session: null };
    const result = await response.json() as { status?: string };
    const status = result.status?.toUpperCase();
    if (status === 'FAILED' || status === 'CANCELLED') {
      await supabaseAdmin.from('gn_transactions').update({ payload: JSON.parse(JSON.stringify({ ...txn, status: 'Failed' })) }).eq('id', txn.id);
      throw new Error('Payment failed or was cancelled');
    }
    if (status !== 'SUCCESS') return { pending: true, session: null };
  }
  const { data: existing } = await context.supabase.from('gn_sessions').select('payload').eq('id', txn.id).maybeSingle();
  if (existing) return { pending: false, session: existing.payload as unknown as Session };
  const now = Date.now(), totalMs = getPass(txn.passId).hours * 3600_000;
  const session: Session = { id: txn.id, phone: txn.phone, passId: txn.passId, totalMs, remainingMs: totalMs, lastTick: now, online: false, startedAt: now };
  const { error } = await supabaseAdmin.from('gn_sessions').upsert({ id: txn.id, user_id: context.userId, payload: JSON.parse(JSON.stringify(session)) }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw new Error('Unable to activate pass');
  await supabaseAdmin.from('gn_transactions').update({ payload: JSON.parse(JSON.stringify({ ...txn, status: 'Activated' })) }).eq('id', txn.id);
  return { pending: false, session };
});

export const heartbeatSession = createServerFn({ method: 'POST' }).middleware([requireSupabaseAuth])
.inputValidator((input) => z.object({ id: z.string(), bssid: z.string().nullable(), relayReady: z.boolean().default(false) }).parse(input))
.handler(async ({ data, context }) => {
  const { data: row } = await context.supabase.from('gn_sessions').select('*').eq('id', data.id).eq('user_id',context.userId).single();
  if (!row) throw new Error('Pass not found');
  const session = row.payload as unknown as Session;
  const { data: pool } = await context.supabase.from('gn_networks').select('bssid');
  const online = Boolean(data.bssid && pool?.some((n) => n.bssid.toUpperCase() === data.bssid?.toUpperCase())) || data.relayReady;
  const now = Date.now();
  const updated = { ...session, remainingMs: tick(session.remainingMs, session.lastTick, Math.min(now, session.lastTick + 30_000), session.online), lastTick: now, online };
  const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
  const { error } = await supabaseAdmin.from('gn_sessions').update({ payload: JSON.parse(JSON.stringify(updated)), updated_at: new Date(now).toISOString() }).eq('id', session.id).eq('user_id',context.userId);
  if (error) throw new Error('Unable to sync pass');
  return updated;
});
