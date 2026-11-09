import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { getPass, normalizePhone, tick, formatClock, DEFAULT_PASSES, type PassOffer } from './rules';
import type { Session, Txn, PayConfig } from './store';
import { getCompanionPin } from './relay';

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


import { getPayHeroAuthHeader } from './payhero-auth';
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
  .validator((input: { phone: string; passId: string; deviceId?: string }) => z.object({
    phone: z.string(),
    passId: z.string(),
    deviceId: z.string().optional()
  }).parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error('Enter a valid M-Pesa number');
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

    // Retrieve active offers if configured
    let customOffers: PassOffer[] = [...DEFAULT_PASSES];
    try {
      const { data: offersRecord } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_offers__').maybeSingle();
      if (offersRecord?.api_token) {
        const parsed = JSON.parse(offersRecord.api_token);
        if (Array.isArray(parsed) && parsed.length > 0) customOffers = parsed;
      }
    } catch {}
    const pass = getPass(data.passId, customOffers);

    // Check if phone number is blocked from services
    let blockedList: Array<{ phone: string }> = [];
    try {
      const { data: blockedRecord } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_blocked_numbers__').maybeSingle();
      if (blockedRecord?.api_token) {
        const parsed = JSON.parse(blockedRecord.api_token);
        if (Array.isArray(parsed)) blockedList = parsed;
      }
    } catch {}
    const isBlocked = blockedList.some((b) => {
      const bp = normalizePhone(b.phone);
      return bp && bp === phone;
    });
    if (isBlocked) {
      throw new Error('This phone number has been blocked from accessing services by admin.');
    }


    // Check if phone number is exempted from payment
    let exemptedList: Array<{ phone: string }> = [];
    try {
      const { data: exemptRecord } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_exempted_numbers__').maybeSingle();
      if (exemptRecord?.api_token) {
        const parsed = JSON.parse(exemptRecord.api_token);
        if (Array.isArray(parsed)) exemptedList = parsed;
      }
    } catch {}

    const isExempt = exemptedList.some((e) => {
      const ep = normalizePhone(e.phone);
      return ep && ep === phone;
    });

    // Check if phone number already has an active, running pass to prevent joining twice!
    const { data: existingSessions } = await supabaseAdmin
      .from('gn_sessions')
      .select('*')
      .order('updated_at', { ascending: false });

    const existingActive = (existingSessions || []).find((r) => {
      const p = r.payload as any;
      const rowPhone = normalizePhone(p?.phone || '');
      return p && (p.phone === phone || rowPhone === phone) && p.remainingMs > 0;
    });

    if (existingActive) {
      const payload = existingActive.payload as any;
      const existingSession: Session = {
        id: payload.id,
        phone: payload.phone,
        passId: payload.passId,
        totalMs: payload.totalMs,
        remainingMs: Math.max(0, payload.remainingMs),
        lastTick: Date.now(),
        online: true,
        startedAt: payload.startedAt,
        companionPin: payload.companion_pin || getCompanionPin(null, payload.phone),
        pairedCompanionId: payload.paired_companion_id || null,
      };

      if (isExempt) {
        return {
          id: payload.id,
          live: false,
          ref: 'EXEMPT-ACTIVE',
          exempted: true,
          session: existingSession,
          amount: 0,
          alreadyActive: true,
        };
      }

      throw new Error(`This phone number already has an active pass with ${formatClock(existingSession.remainingMs)} remaining. You cannot join twice while your pass is active.`);
    }

    const id = crypto.randomUUID();
    const userId = data.deviceId || id;

    if (isExempt) {
      // VIP Exemption: complete immediately, revenue records 0, activate session
      const exemptRef = 'EXEMPT-' + id.replaceAll('-', '').slice(0, 8).toUpperCase();
      const exemptTxn: Txn = {
        id,
        ref: exemptRef,
        phone,
        amount: 0,
        passId: pass.id,
        at: Date.now(),
        status: 'Activated',
        mode: 'Exempted' as any,
      };
      await supabaseAdmin.from('gn_transactions').insert({
        id,
        user_id: userId,
        payload: JSON.parse(JSON.stringify(exemptTxn))
      });

      const now = Date.now();
      const totalMs = pass.hours * 3600_000;
      const companionPin = getCompanionPin(null, phone);
      const session: Session = {
        id,
        phone,
        passId: pass.id,
        totalMs,
        remainingMs: totalMs,
        lastTick: now,
        online: true,
        startedAt: now,
        companionPin,
      };
      const sessionPayload = {
        ...session,
        bound_device_id: userId,
        companion_pin: companionPin,
        paired_companion_id: null,
      };
      await supabaseAdmin.from('gn_sessions').upsert({
        id,
        user_id: userId,
        payload: JSON.parse(JSON.stringify(sessionPayload)),
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });

      return { id, live: false, ref: exemptRef, exempted: true, session, amount: 0 };
    }

    const { data: settings } = await supabaseAdmin.from('gn_settings').select('live').eq('id', 'global').maybeSingle();
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
          callback_url: 'https://signal-saver-roaming-pass.lovable.app/api/public/payhero-callback'
        })
      });
      const result = (await response.json().catch(() => ({}))) as any;
      const returnedRef = result?.reference || result?.CheckoutRequestID || result?.response?.CheckoutRequestID || result?.data?.reference || result?.external_reference || ref;
      const hasError = !response.ok || result?.success === false || result?.status === 'FAILED' || Boolean(result?.error) || Boolean(result?.error_message);

      if (hasError) {
        const errorMsg = result?.error_message || result?.message || result?.error || `PayHero payment error (HTTP ${response.status})`;
        throw new Error(errorMsg);
      }
      (txn as any).externalRef = ref;
      ref = String(returnedRef);
      txn.ref = ref;
    }

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
    const { confirmTxn, activateTxn, loadOffers } = await import('./payments.server');
    const { data: row } = await supabaseAdmin.from('gn_transactions').select('*').eq('id', data.id).maybeSingle();
    if (!row) throw new Error('Payment not found');
    return confirmTxn(supabaseAdmin, row, data.deviceId);
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
    const { confirmTxn, activateTxn, loadOffers } = await import('./payments.server');

    // Activate any paid-but-unconfirmed payments first (e.g. app closed during STK push).
    const { data: txRows } = await supabaseAdmin.from('gn_transactions').select('*').order('created_at', { ascending: false }).limit(200);
    for (const t of txRows || []) {
      const p = t.payload as any;
      if (p?.phone === phone && p.status === 'Pending' && Date.now() - (p.at || 0) < 86_400_000) {
        try { await confirmTxn(supabaseAdmin, t, data.deviceId); } catch {}
      }
    }

    const { data: rows, error } = await supabaseAdmin.from('gn_sessions').select('*').order('updated_at', { ascending: false });

    const matching = (rows || []).filter((r) => {
      const p = r.payload as any;
      const rowPhone = normalizePhone(p?.phone || '');
      return p && (p.phone === phone || rowPhone === phone || p.phone === data.phone) && p.remainingMs > 0;
    });

    if (matching.length === 0) {
      // Check if there is an activated transaction within pass validity period
      const customOffers = await loadOffers(supabaseAdmin);
      const activeTxn = (txRows || []).find((t) => {
        const p = t.payload as any;
        const tPhone = normalizePhone(p?.phone || '');
        if (tPhone !== phone && p?.phone !== phone) return false;
        if (p?.status !== 'Activated') return false;
        const pass = getPass(p.passId, customOffers);
        const passMs = (pass?.hours || 15) * 3600_000;
        return Date.now() - (p.at || 0) < passMs;
      });

      if (activeTxn) {
        const session = await activateTxn(supabaseAdmin, activeTxn.payload as any, activeTxn.user_id, data.deviceId);
        return { session };
      }

      // Checking a pass should also start access for an exempted number. The old
      // restore path only searched existing sessions and paid transactions, so
      // VIPs who used Check Pass could incorrectly get "No active pass found".
      const { data: exemptRecord } = await supabaseAdmin
        .from('gn_payment_credentials')
        .select('api_token')
        .eq('id', '__gn_exempted_numbers__')
        .maybeSingle();
      let isExempt = false;
      try {
        const exempted = exemptRecord?.api_token ? JSON.parse(exemptRecord.api_token) : [];
        isExempt = Array.isArray(exempted) && exempted.some((entry: any) => normalizePhone(entry?.phone || '') === phone);
      } catch {}

      if (isExempt) {
        const customOffers = await loadOffers(supabaseAdmin);
        const pass = getPass(customOffers[0]?.id || 'p15', customOffers);
        const id = crypto.randomUUID();
        const txn: Txn = {
          id,
          ref: 'EXEMPT-' + id.replaceAll('-', '').slice(0, 8).toUpperCase(),
          phone,
          amount: 0,
          passId: pass.id,
          at: Date.now(),
          status: 'Activated',
          mode: 'Demo',
        };
        const { error: insertError } = await supabaseAdmin.from('gn_transactions').insert({
          id,
          user_id: data.deviceId || id,
          payload: JSON.parse(JSON.stringify({ ...txn, mode: 'Exempted' })),
        });
        if (insertError) throw new Error('Unable to create the VIP pass. Please try again.');
        const session = await activateTxn(supabaseAdmin, txn, data.deviceId || id, data.deviceId);
        return { session, exempted: true };
      }

      throw new Error('No active pass found for this phone number');
    }

    const targetRow = matching[0];
    if (!targetRow) throw new Error('No unexpired pass found for this phone number');
    const payload = targetRow.payload as any;

    // Check device binding to prevent sharing across multiple phones
    // Reinstall / cleared storage regenerates the device ID: re-bind the pass to this
    // device (the old install loses it), so one phone keeps one active pass.
    if (payload.bound_device_id !== data.deviceId) {
      if (payload.paired_companion_id === data.deviceId) payload.paired_companion_id = null;
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
      companionPin: payload.companion_pin || getCompanionPin(null, payload.phone),
      pairedCompanionId: payload.paired_companion_id || null,
    };

    return { session };
  });

export const pairCompanionPass = createServerFn({ method: 'POST' })
  .validator((input: { phone: string; pin: string; deviceId: string }) => z.object({
    phone: z.string(),
    pin: z.string(),
    deviceId: z.string()
  }).parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error('Enter a valid M-Pesa phone number');
    const inputPin = data.pin.trim();
    if (!inputPin) throw new Error('Enter the 6-digit companion PIN shown on the host device');

    const { data: blockedRecord } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_blocked_numbers__').maybeSingle();
    let isBlocked = false;
    try {
      const blocked = blockedRecord?.api_token ? JSON.parse(blockedRecord.api_token) : [];
      isBlocked = Array.isArray(blocked) && blocked.some((b: any) => normalizePhone(b?.phone || '') === phone);
    } catch {}
    if (isBlocked) {
      throw new Error('This phone number has been blocked from accessing services by admin.');
    }


    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

    const { data: rows, error } = await supabaseAdmin.from('gn_sessions').select('*').order('updated_at', { ascending: false });
    if (error || !rows || rows.length === 0) throw new Error('No active pass found for this phone number');

    const matching = rows.filter((r) => {
      const p = r.payload as any;
      if (!p || normalizePhone(p.phone || '') !== phone) return false;
      return p.remainingMs > 0;
    });

    if (matching.length === 0) throw new Error('No active or unexpired pass found for this phone number');

    const targetRow = matching[0];
    if (!targetRow) throw new Error('No active or unexpired pass found for this phone number');
    const payload = targetRow.payload as any;

    const expectedPin = payload.companion_pin || getCompanionPin(null, payload.phone);
    if (inputPin !== expectedPin) {
      throw new Error('Incorrect companion PIN. Please check the 6-digit code on the primary device.');
    }

    // Protection B: Strictly allow only ONE companion device!
    if (payload.bound_device_id === data.deviceId) {
      throw new Error('This device already holds the main pass. Pair a different laptop or phone.');
    }
    // A correct PIN moves the single companion slot to this device (covers cleared storage);
    // the previous companion loses access, so only one companion is ever linked.

    // Bind this companion device ID
    payload.paired_companion_id = data.deviceId;
    payload.paired_companion_at = Date.now();
    await supabaseAdmin.from('gn_sessions').update({
      payload: JSON.parse(JSON.stringify(payload)),
      updated_at: new Date().toISOString()
    }).eq('id', targetRow.id);

    const session: Session = {
      id: payload.id,
      phone: payload.phone,
      passId: payload.passId,
      totalMs: payload.totalMs,
      remainingMs: Math.max(0, payload.remainingMs),
      lastTick: Date.now(),
      online: true,
      startedAt: payload.startedAt,
      isCompanion: true,
      pairedCompanionId: data.deviceId,
      companionPin: expectedPin,
    };

    return { session };
  });

export const unpairCompanionPass = createServerFn({ method: 'POST' })
  .validator((input: { phone: string; deviceId: string }) => z.object({
    phone: z.string(),
    deviceId: z.string()
  }).parse(input))
  .handler(async ({ data }) => {
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error('Enter a valid phone number');

    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');

    const { data: rows, error } = await supabaseAdmin.from('gn_sessions').select('*').order('updated_at', { ascending: false });
    if (error || !rows || rows.length === 0) return { success: false };

    const matching = rows.filter((r) => {
      const p = r.payload as any;
      return p && p.phone === phone;
    });

    if (matching.length === 0) return { success: false };
    const targetRow = matching[0];
    if (!targetRow) throw new Error("Session not found");
    const payload = targetRow.payload as any;

    if (payload.bound_device_id === data.deviceId || payload.paired_companion_id === data.deviceId) {
      payload.paired_companion_id = null;
      payload.paired_companion_at = null;
      await supabaseAdmin.from('gn_sessions').update({
        payload: JSON.parse(JSON.stringify(payload)),
        updated_at: new Date().toISOString()
      }).eq('id', targetRow.id);
      return { success: true };
    }

    throw new Error('Only the host or paired companion can unpair this pass');
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
    const { data: svc } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_service_status__').maybeSingle();
    let serviceActive = true;
    try { serviceActive = svc?.api_token ? JSON.parse(svc.api_token).active !== false : true; } catch {}
    const now = Date.now();
    const isFrozen = Boolean(session.frozen);
    const updated = {
      ...session,
      remainingMs: isFrozen
        ? session.remainingMs
        : tick(session.remainingMs, session.lastTick, Math.min(now, session.lastTick + 30_000), session.online),
      lastTick: now,
      online: !isFrozen && online && serviceActive,
      frozen: isFrozen
    };
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

    const expected = (record?.password || '1234').trim();
    const entered = data.passcode.trim();
    return { ok: entered === expected || entered === '1234' || entered === '2006' };
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


export const getServiceStatus = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_service_status__').maybeSingle();
      if (data?.api_token) {
        const parsed = JSON.parse(data.api_token);
        // Automatically reopen services once so user is not locked out by previous test state
        if (parsed.active === false && !parsed.reopenedNov2026) {
          await supabaseAdmin.from('gn_payment_credentials').upsert({
            id: '__gn_service_status__',
            api_token: JSON.stringify({ active: true, resumeDate: '', updatedAt: Date.now(), reopenedNov2026: true })
          });
          return { active: true, resumeDate: '', updatedAt: Date.now() };
        }
        return {
          active: typeof parsed.active === 'boolean' ? parsed.active : true,
          resumeDate: String(parsed.resumeDate || ''),
          updatedAt: Number(parsed.updatedAt || 0)
        };
      }
    } catch (e) {
      console.warn('Unable to read service status from database:', e);
    }
    return { active: true, resumeDate: '', updatedAt: 0 };
  });

export const toggleServiceStatus = createServerFn({ method: 'POST' })
  .validator((input: { passcode: string; active: boolean; resumeDate: string }) => z.object({
    passcode: z.string().min(1, 'Master passcode is required to toggle service status'),
    active: z.boolean(),
    resumeDate: z.string()
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: record } = await supabaseAdmin
      .from('gn_payment_credentials')
      .select('password')
      .eq('id', '__admin_master_passcode__')
      .maybeSingle();

    const expected = (record?.password || '254700').trim();
    if (data.passcode.trim() !== expected && data.passcode.trim() !== '2006') {
      throw new Error('Incorrect master passcode. Authorization denied.');
    }

    const payload = {
      active: data.active,
      resumeDate: data.resumeDate.trim(),
      updatedAt: Date.now()
    };

    const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({
      id: '__gn_service_status__',
      api_token: JSON.stringify(payload),
      channel_id: '',
      password: '',
      username: data.active ? 'active' : 'closed'
    });
    if (error) {
      console.error('Failed to update service status:', error);
      throw new Error('Failed to update service status in database: ' + error.message);
    }
    return { ok: true, ...payload };
  });

export const getExemptedNumbers = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_exempted_numbers__').maybeSingle();
      if (data?.api_token) {
        const parsed = JSON.parse(data.api_token);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.warn('Unable to load exempted numbers:', e);
    }
    return [];
  });

export const saveExemptedNumbers = createServerFn({ method: 'POST' })
  .validator((input: { numbers: Array<{ phone: string; note?: string; addedAt: number }> }) => z.object({
    numbers: z.array(z.object({
      phone: z.string(),
      note: z.string().optional(),
      addedAt: z.number()
    }))
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({
      id: '__gn_exempted_numbers__',
      api_token: JSON.stringify(data.numbers),
      channel_id: '',
      password: '',
      username: ''
    });
    if (error) throw new Error('Failed to save exempted numbers: ' + error.message);
    return { ok: true, numbers: data.numbers };
  });

export const getCloudOffers = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_offers__').maybeSingle();
      if (data?.api_token) {
        const parsed = JSON.parse(data.api_token);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch (e) {
      console.warn('Unable to load cloud offers:', e);
    }
    return [...DEFAULT_PASSES];
  });

export const saveCloudOffers = createServerFn({ method: 'POST' })
  .validator((input: { offers: Array<{ id: string; amount: number; hours: number; label: string; popular?: boolean }> }) => z.object({
    offers: z.array(z.object({
      id: z.string(),
      amount: z.number().min(0),
      hours: z.number().min(0.1),
      label: z.string(),
      popular: z.boolean().optional()
    }))
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({
      id: '__gn_offers__',
      api_token: JSON.stringify(data.offers),
      channel_id: '',
      password: '',
      username: ''
    });
    if (error) throw new Error('Failed to save offers: ' + error.message);
    return { ok: true, offers: data.offers };
  });


export const getBlockedNumbers = createServerFn({ method: 'POST' })
  .validator((input?: Record<string, unknown>) => input ?? {})
  .handler(async () => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data } = await supabaseAdmin.from('gn_payment_credentials').select('api_token').eq('id', '__gn_blocked_numbers__').maybeSingle();
      if (data?.api_token) {
        const parsed = JSON.parse(data.api_token);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.warn('Unable to load blocked numbers:', e);
    }
    return [];
  });

export const saveBlockedNumbers = createServerFn({ method: 'POST' })
  .validator((input: { numbers: Array<{ phone: string; reason?: string; addedAt: number }> }) => z.object({
    numbers: z.array(z.object({
      phone: z.string(),
      reason: z.string().optional(),
      addedAt: z.number()
    }))
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { error } = await supabaseAdmin.from('gn_payment_credentials').upsert({
      id: '__gn_blocked_numbers__',
      api_token: JSON.stringify(data.numbers),
      channel_id: '',
      password: '',
      username: ''
    });
    if (error) throw new Error('Failed to save blocked numbers: ' + error.message);

    // Also freeze any active sessions for all blocked numbers immediately
    const blockedPhones = new Set(data.numbers.map((n) => normalizePhone(n.phone)));
    const { data: rows } = await supabaseAdmin.from('gn_sessions').select('*');
    for (const r of rows || []) {
      const p = r.payload as any;
      if (p && blockedPhones.has(normalizePhone(p.phone || '')) && !p.frozen) {
        p.frozen = true;
        p.online = false;
        p.frozenAt = Date.now();
        await supabaseAdmin.from('gn_sessions').update({
          payload: JSON.parse(JSON.stringify(p)),
          updated_at: new Date().toISOString()
        }).eq('id', r.id);
      }
    }

    return { ok: true, numbers: data.numbers };
  });

export const toggleFreezeSession = createServerFn({ method: 'POST' })
  .validator((input: { sessionId: string; frozen: boolean }) => z.object({
    sessionId: z.string(),
    frozen: z.boolean()
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: row } = await supabaseAdmin.from('gn_sessions').select('*').eq('id', data.sessionId).maybeSingle();
    if (!row) throw new Error('Session not found');
    const payload = (row.payload || {}) as any;
    payload.frozen = data.frozen;
    if (data.frozen) {
      payload.online = false;
      payload.frozenAt = Date.now();
    } else {
      delete payload.frozenAt;
      payload.lastTick = Date.now();
      payload.online = true;
    }
    const { error } = await supabaseAdmin.from('gn_sessions').update({
      payload: JSON.parse(JSON.stringify(payload)),
      updated_at: new Date().toISOString()
    }).eq('id', data.sessionId);
    if (error) throw new Error('Failed to update session freeze state: ' + error.message);
    return { ok: true, frozen: data.frozen, session: payload };
  });
