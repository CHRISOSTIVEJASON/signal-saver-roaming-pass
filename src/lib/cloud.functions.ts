import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { getPass, normalizePhone, tick } from './rules';
import type { Session, Txn, PayConfig } from './store';

export const getAdminPaymentConfig = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const [credsRes, settingsRes] = await Promise.all([
        supabaseAdmin.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle(),
        supabaseAdmin.from('gn_settings').select('*').eq('id', 'global').maybeSingle()
      ]);
      const creds = credsRes.data;
      const settings = settingsRes.data;
      return {
        apiToken: creds?.api_token || '',
        username: creds?.username || '',
        password: creds?.password || '',
        channelId: creds?.channel_id || '',
        live: settings?.live ?? false,
        apkUrl: settings?.apk_url || '',
        latestVersion: settings?.latest_version || '1.0.0',
        updateRequired: settings?.update_required ?? false,
      };
    } catch (err) {
      console.warn('Unable to read admin payment config from database:', err);
      return null;
    }
  });


function getPayHeroAuthHeader(credentials: { api_token?: string; username?: string; password?: string }) {
  const token = (credentials.api_token || '').trim();
  if (token) {
    if (token.toLowerCase().startsWith('basic ')) return token;
    if (token.toLowerCase().startsWith('bearer ')) return token;
    // If it already looks like base64-encoded credentials (min 16 chars, no spaces, valid base64 chars)
    if (/^[A-Za-z0-9+/=]{16,}$/.test(token) && !token.includes(':')) {
      try {
        const decoded = atob(token);
        if (decoded.includes(':') || decoded.length > 5) {
          return `Basic ${token}`;
        }
      } catch {}
    }
    if (token.includes(':')) return `Basic ${btoa(token)}`;
    return `Basic ${btoa(`${token}:`)}`;
  }
  const u = (credentials.username || '').trim();
  const p = (credentials.password || '').trim();
  return `Basic ${btoa(`${u}:${p}`)}`;
}
export const savePaymentConfig = createServerFn({ method: 'POST' })
  .validator((data: PayConfig) => data)
  .handler(async ({ data }) => {
    if (data.apkUrl && !/^https:\/\//.test(data.apkUrl)) throw new Error('Use an HTTPS APK download link');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

    const { data: existingCreds } = await supabaseAdmin.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle();
    const hasCredUpdates = Boolean(data.apiToken || data.username || data.password || data.channelId);

    if (hasCredUpdates || !existingCreds) {
      const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({
        id: 'global',
        api_token: data.apiToken !== undefined && data.apiToken !== '' ? data.apiToken : (existingCreds?.api_token || ''),
        username: data.username !== undefined && data.username !== '' ? data.username : (existingCreds?.username || ''),
        password: data.password !== undefined && data.password !== '' ? data.password : (existingCreds?.password || ''),
        channel_id: data.channelId !== undefined && data.channelId !== '' ? data.channelId : (existingCreds?.channel_id || '')
      });
      if (error) {
        console.error('Unable to save payment credentials:', error);
        throw new Error('Unable to save payment credentials: ' + error.message);
      }
    }

    const { data: existingSettings } = await supabaseAdmin.from('gn_settings').select('*').eq('id', 'global').maybeSingle();
    const { error: settingsError } = await supabaseAdmin.from('gn_settings').upsert({
      id: 'global',
      apk_url: data.apkUrl !== undefined && data.apkUrl !== '' ? data.apkUrl : (existingSettings?.apk_url || ''),
      latest_version: data.latestVersion !== undefined && data.latestVersion !== '' ? data.latestVersion : (existingSettings?.latest_version || '1.0.0'),
      update_required: data.updateRequired !== undefined ? Boolean(data.updateRequired) : Boolean(existingSettings?.update_required),
      live: typeof data.live === "boolean" ? data.live : (existingSettings?.live ?? false)
    });
    if (settingsError) throw new Error('Unable to save settings');
    return { ok: true };
  });

export const startCloudPayment = createServerFn({ method: 'POST' })
  .validator((input: { phone: string; passId: 'p15' | 'p30'; deviceId?: string }) => z.object({
    phone: z.string(),
    passId: z.enum(['p15', 'p30']),
    deviceId: z.string().optional()
  }).parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error('Enter a valid M-Pesa number');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: settings } = await supabaseAdmin.from('gn_settings').select('live').eq('id', 'global').maybeSingle();
    const pass = getPass(data.passId);
    const id = crypto.randomUUID();
    let ref = 'GN' + id.replaceAll('-', '').slice(0, 12).toUpperCase();
    const live = settings?.live ?? false;
    const txn: Txn = { id, ref, phone, amount: pass.amount, passId: pass.id, at: Date.now(), status: 'Pending', mode: live ? 'Live' : 'Demo' };

    if (live) {
      const { data: credentials } = await supabaseAdmin.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle();
      if (!credentials?.channel_id || !(credentials.api_token || (credentials.username && credentials.password))) {
        throw new Error('Merchant has not configured live payment details yet. Set Channel ID and API Key in Admin Console.');
      }
      const authorization = getPayHeroAuthHeader(credentials);
      const channelNum = Number(String(credentials.channel_id).trim());
      if (isNaN(channelNum) || channelNum <= 0) {
        throw new Error('Invalid PayHero Channel ID configured in Admin Console.');
      }

      const response = await fetch('https://backend.payhero.co.ke/api/v2/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', Authorization: authorization },
        body: JSON.stringify({
          amount: pass.amount,
          phone_number: phone,
          channel_id: channelNum,
          provider: 'm-pesa',
          external_reference: ref,
          callback_url: 'https://signal-saver-roaming-pass.lovable.app/api/payhero-callback'
        })
      });
      const result = (await response.json().catch(() => ({}))) as any;
      const returnedRef = result?.reference || result?.CheckoutRequestID || result?.response?.CheckoutRequestID || result?.data?.reference || result?.external_reference || ref;
      const hasError = !response.ok || result?.success === false || result?.status === 'FAILED' || Boolean(result?.error) || Boolean(result?.error_message);

      if (hasError) {
        const errorMsg = result?.error_message || result?.message || result?.error || `PayHero payment error (HTTP ${response.status})`;
        throw new Error(errorMsg);
      }
      ref = String(returnedRef);
      txn.ref = ref;
    }

    const userId = data.deviceId || id;
    await supabaseAdmin.from('gn_transactions').insert({
      id,
      user_id: userId,
      payload: JSON.parse(JSON.stringify(txn))
    });

    return { id, live, ref };
  });

export const confirmCloudPayment = createServerFn({ method: 'POST' })
  .validator((input: { id: string; deviceId?: string }) => z.object({
    id: z.string(),
    deviceId: z.string().optional()
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: row } = await supabaseAdmin.from('gn_transactions').select('*').eq('id', data.id).maybeSingle();
    if (!row) throw new Error('Payment not found');
    const txn = row.payload as unknown as Txn;
    if (txn.status === 'Failed') throw new Error('Payment was cancelled or failed');

    if (txn.mode === 'Live' && txn.status !== 'Activated') {
      const { data: c } = await supabaseAdmin.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle();
      if (!c) throw new Error('Payment configuration unavailable');
      const authorization = getPayHeroAuthHeader(c);
      let response = await fetch(`https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(txn.ref)}`, {
        headers: { Authorization: authorization, Accept: 'application/json' }
      });
      // If 404, fallback to query by external_reference
      if (!response.ok && response.status === 404) {
        response = await fetch(`https://backend.payhero.co.ke/api/v2/transaction-status?external_reference=${encodeURIComponent(txn.ref)}`, {
          headers: { Authorization: authorization, Accept: 'application/json' }
        });
      }
      if (!response.ok) {
        // Temporary server / network glitch: keep pending so polling continues smoothly
        return { pending: true, session: null };
      }
      const raw = (await response.json().catch(() => ({}))) as any;

      const dataObj = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
      const responseObj = (raw && typeof raw === 'object' && raw.response) ? raw.response : {};

      const statusStr = String(dataObj?.status ?? raw?.status ?? raw?.Status ?? dataObj?.status_text ?? '').trim().toUpperCase();
      const resultCode = responseObj?.ResultCode ?? dataObj?.ResultCode ?? raw?.ResultCode ?? dataObj?.result_code ?? raw?.result_code;
      const paymentSuccess = dataObj?.paymentSuccess ?? raw?.paymentSuccess ?? false;
      const isPaid = dataObj?.is_paid ?? raw?.is_paid ?? false;
      const successFlag = dataObj?.success ?? raw?.success ?? false;

      // MULTIPLE APPROVAL CHECKS: recognize any standard success indicator immediately
      const isApproved =
        statusStr === 'SUCCESS' ||
        statusStr === 'SUCCESSFUL' ||
        statusStr === 'COMPLETED' ||
        statusStr === 'COMPLETE' ||
        statusStr === 'PAID' ||
        statusStr === 'CONFIRMED' ||
        resultCode === 0 ||
        resultCode === '0' ||
        paymentSuccess === true ||
        isPaid === true ||
        (successFlag === true && statusStr !== 'QUEUED' && statusStr !== 'PENDING');

      // Failure check: only mark failed if Safaricom or PayHero definitively returns rejection/cancel
      const isDefinitiveFailure =
        !isApproved &&
        (statusStr === 'FAILED' ||
         statusStr === 'CANCELLED' ||
         statusStr === 'CANCELED' ||
         statusStr === 'REJECTED' ||
         resultCode === 1 ||
         resultCode === 1031 ||
         resultCode === 1032 ||
         resultCode === 1037);

      if (isDefinitiveFailure) {
        await supabaseAdmin.from('gn_transactions').update({ payload: JSON.parse(JSON.stringify({ ...txn, status: 'Failed' })) }).eq('id', txn.id);
        throw new Error('Payment was cancelled or declined on your phone');
      }

      if (!isApproved) return { pending: true, session: null };
    }

    const { data: existing } = await supabaseAdmin.from('gn_sessions').select('payload').eq('id', txn.id).maybeSingle();
    if (existing) return { pending: false, session: existing.payload as unknown as Session };

    const now = Date.now(), totalMs = getPass(txn.passId).hours * 3600_000;
    const session: Session = {
      id: txn.id,
      phone: txn.phone,
      passId: txn.passId,
      totalMs,
      remainingMs: totalMs,
      lastTick: now,
      online: true,
      startedAt: now,
    };
    const sessionPayload = {
      ...session,
      bound_device_id: data.deviceId || txn.id,
    };

    await supabaseAdmin.from('gn_sessions').upsert({
      id: txn.id,
      user_id: data.deviceId || txn.id,
      payload: JSON.parse(JSON.stringify(sessionPayload))
    }, { onConflict: 'id', ignoreDuplicates: true });

    await supabaseAdmin.from('gn_transactions').update({
      payload: JSON.parse(JSON.stringify({ ...txn, status: 'Activated' }))
    }).eq('id', txn.id);

    return { pending: false, session };
  });

export const restoreCloudPass = createServerFn({ method: 'POST' })
  .validator((input: { phone: string; deviceId: string }) => z.object({
    phone: z.string(),
    deviceId: z.string()
  }).parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error('Enter a valid M-Pesa phone number');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

    const { data: rows, error } = await supabaseAdmin.from('gn_sessions').select('*').order('updated_at', { ascending: false });
    if (error || !rows || rows.length === 0) throw new Error('No active pass found for this phone number');

    const matching = rows.filter((r) => {
      const p = r.payload as any;
      if (!p || p.phone !== phone) return false;
      const isUnexpired = p.remainingMs > 0 || (p.startedAt && p.startedAt + (p.totalMs || 0) > Date.now());
      return isUnexpired;
    });

    if (matching.length === 0) throw new Error('No unexpired pass found for this phone number');

    const targetRow = matching[0];
    if (!targetRow) throw new Error('No unexpired pass found for this phone number');
    const payload = targetRow.payload as any;

    // Check device binding to prevent sharing across multiple phones
    if (payload.bound_device_id && payload.bound_device_id !== data.deviceId) {
      throw new Error('This pass is already registered on another device. Sharing passes across phones is not permitted.');
    }

    // Bind this device if not yet bound
    if (!payload.bound_device_id) {
      payload.bound_device_id = data.deviceId;
      await supabaseAdmin.from('gn_sessions').update({
        payload: JSON.parse(JSON.stringify(payload)),
        updated_at: new Date().toISOString()
      }).eq('id', targetRow.id);
    }

    const session: Session = {
      id: payload.id,
      phone: payload.phone,
      passId: payload.passId,
      totalMs: payload.totalMs,
      remainingMs: Math.max(0, payload.remainingMs),
      lastTick: Date.now(),
      online: true,
      startedAt: payload.startedAt,
    };

    return { session };
  });

export const heartbeatSession = createServerFn({ method: 'POST' })
  .validator((input: { id: string; bssid: string | null; relayReady?: boolean; deviceId?: string }) => z.object({
    id: z.string(),
    bssid: z.string().nullable(),
    relayReady: z.boolean().default(false),
    deviceId: z.string().optional()
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: row } = await supabaseAdmin.from('gn_sessions').select('*').eq('id', data.id).maybeSingle();
    if (!row) throw new Error('Pass not found');
    const session = row.payload as unknown as Session;
    const { data: pool } = await supabaseAdmin.from('gn_networks').select('bssid');
    const online = Boolean(data.bssid && pool?.some((n) => n.bssid.toUpperCase() === data.bssid?.toUpperCase())) || Boolean(data.relayReady);
    const now = Date.now();
    const updated = { ...session, remainingMs: tick(session.remainingMs, session.lastTick, Math.min(now, session.lastTick + 30_000), session.online), lastTick: now, online };
    await supabaseAdmin.from('gn_sessions').update({
      payload: JSON.parse(JSON.stringify(updated)),
      updated_at: new Date(now).toISOString()
    }).eq('id', session.id);
    return updated;
  });

export const verifyMasterPasscode = createServerFn({ method: 'POST' })
  .validator((input: { passcode: string }) => z.object({ passcode: z.string() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: record } = await supabaseAdmin
      .from('gn_payment_credentials')
      .select('password')
      .eq('id', '__admin_master_passcode__')
      .maybeSingle();

    const expected = record?.password || '254700';
    return { ok: data.passcode.trim() === expected.trim() };
  });

export const updateMasterPasscode = createServerFn({ method: 'POST' })
  .validator((input: { currentSecurityCode: string; newPasscode: string }) => z.object({
    currentSecurityCode: z.string(),
    newPasscode: z.string()
  }).parse(input))
  .handler(async ({ data }) => {
    if (data.currentSecurityCode.trim() !== '2006') {
      throw new Error('Invalid security code');
    }
    if (!/^\d{4,8}$/.test(data.newPasscode.trim())) {
      throw new Error('Passcode must be 4 to 8 digits');
    }
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({
      id: '__admin_master_passcode__',
      password: data.newPasscode.trim(),
      api_token: '',
      channel_id: '',
      username: ''
    });
    if (error) {
      console.error('Failed to update cloud master passcode:', error);
      throw new Error('Failed to update master passcode in cloud: ' + error.message);
    }
    return { ok: true, passcode: data.newPasscode.trim() };
  });

export const syncCloudNetworks = createServerFn({ method: 'POST' })
  .validator((input: { networks: Array<{ id: string; ssid: string; bssid: string; venue?: string; addedAt?: number }> }) =>
    z.object({
      networks: z.array(z.object({
        id: z.string(),
        ssid: z.string(),
        bssid: z.string(),
        venue: z.string().optional().default(''),
        addedAt: z.number().optional().default(Date.now()),
      }))
    }).parse(input)
  )
  .handler(async ({ data }) => {
    if (!data.networks.length) return { ok: true };
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('gn_networks').upsert(
      data.networks.map((n) => ({
        id: n.id,
        ssid: n.ssid.trim(),
        bssid: n.bssid.trim().toUpperCase(),
        venue: n.venue?.trim() || '',
        added_at: n.addedAt || Date.now(),
      }))
    );
    if (error) {
      console.error('Failed to sync networks to cloud:', error);
      throw new Error('Failed to sync networks: ' + error.message);
    }
    return { ok: true };
  });

export const getCloudNetworks = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data, error } = await supabaseAdmin.from('gn_networks').select('*').order('added_at', { ascending: false });
      if (error) {
        console.warn('Error reading gn_networks:', error);
        return [];
      }
      return (data || []).map((n) => ({
        id: n.id,
        ssid: n.ssid,
        bssid: n.bssid,
        venue: n.venue,
        addedAt: n.added_at
      }));
    } catch {
      return [];
    }
  });

export const removeCloudNetwork = createServerFn({ method: 'POST' })
  .validator((input: { id: string }) => z.object({ id: z.string() }).parse(input))
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      await supabaseAdmin.from('gn_captive_credentials').delete().eq('network_id', data.id);
      await supabaseAdmin.from('gn_networks').delete().eq('id', data.id);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });


export const getCloudTransactionsAndSessions = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const [txnsRes, sessionsRes] = await Promise.all([
        supabaseAdmin.from('gn_transactions').select('*').order('created_at', { ascending: false }).limit(100),
        supabaseAdmin.from('gn_sessions').select('*').order('updated_at', { ascending: false }).limit(100)
      ]);
      const txns = (txnsRes.data || []).map((t) => t.payload as unknown as Txn);
      const sessions = (sessionsRes.data || []).map((s) => s.payload as unknown as Session);
      return { txns, sessions };
    } catch (err) {
      console.warn('Unable to read cloud transactions and sessions:', err);
      return { txns: [], sessions: [] };
    }
  });
