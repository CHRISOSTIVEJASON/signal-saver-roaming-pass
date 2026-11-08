import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { captiveSchema, paidCaptiveAccess, type CaptiveConfig } from './captive';
import type { Session, Txn } from './store';

export const getAdminCaptive = createServerFn({ method: 'POST' })
  .validator((input: { networkId: string }) => z.object({ networkId: z.string().min(1).max(100) }).parse(input))
  .handler(async ({ data }) => {
    try {
      const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
      const { data: row, error } = await supabaseAdmin.from('gn_captive_credentials').select('config').eq('network_id', data.networkId).maybeSingle();
      if (error) return null;
      return row ? (captiveSchema.parse(row.config) as CaptiveConfig) : null;
    } catch (err) {
      console.warn('Unable to load captive from database:', err);
      return null;
    }
  });

export const saveAdminCaptive = createServerFn({ method: 'POST' })
  .validator((input: { networkId: string; config: CaptiveConfig | null }) => z.object({ networkId: z.string().min(1).max(100), config: captiveSchema.nullable() }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const query = data.config
      ? supabaseAdmin.from('gn_captive_credentials').upsert({ network_id: data.networkId, config: data.config, updated_at: new Date().toISOString() })
      : supabaseAdmin.from('gn_captive_credentials').delete().eq('network_id', data.networkId);
    const { error } = await query;
    if (error) throw new Error('Unable to save network login');
    return { ok: true };
  });

export const contributeNetworkAndCaptive = createServerFn({ method: 'POST' })
  .validator((input: {
    ssid: string;
    bssid: string;
    venue?: string;
    voucherCode?: string;
    loginUrl?: string;
  }) => z.object({
    ssid: z.string().trim().min(1).max(100),
    bssid: z.string().trim().min(1).max(100),
    venue: z.string().max(100).optional(),
    voucherCode: z.string().max(1024).optional(),
    loginUrl: z.string().max(2048).optional(),
  }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const cleanBssid = data.bssid.trim().toUpperCase();
    const cleanSsid = data.ssid.trim();

    let networkId: string;
    const { data: existing } = await supabaseAdmin
      .from('gn_networks')
      .select('id')
      .ilike('bssid', cleanBssid)
      .maybeSingle();

    if (existing?.id) {
      networkId = existing.id;
    } else {
      networkId = 'gn_' + Math.random().toString(36).slice(2, 10);
      await supabaseAdmin.from('gn_networks').insert({
        id: networkId,
        ssid: cleanSsid,
        bssid: cleanBssid,
        venue: data.venue?.trim() || '',
        added_at: new Date().toISOString()
      });
    }

    if (data.voucherCode && data.voucherCode.trim()) {
      const captiveConfig: CaptiveConfig = {
        kind: 'voucher',
        loginUrl: data.loginUrl?.trim() || 'https://router.local/login',
        username: '',
        secret: data.voucherCode.trim(),
        usernameField: 'username',
        secretField: 'voucher',
      };
      await supabaseAdmin.from('gn_captive_credentials').upsert({
        network_id: networkId,
        config: captiveConfig,
        updated_at: new Date().toISOString()
      });
    }

    return { ok: true, networkId };
  });

export const getPaidCaptive = createServerFn({ method: 'POST' })
  .validator((input: { sessionId: string; bssid: string }) => z.object({ sessionId: z.string().min(1).max(100), bssid: z.string().regex(/^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/) }).parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
    const { data: sessionRow } = await supabaseAdmin.from('gn_sessions').select('payload').eq('id', data.sessionId).maybeSingle();
    const { data: network } = await supabaseAdmin.from('gn_networks').select('id,bssid').ilike('bssid', data.bssid).maybeSingle();
    if (!sessionRow || !network) throw new Error('Active pass and registered network required');
    const { data: row, error } = await supabaseAdmin.from('gn_captive_credentials').select('config,updated_at').eq('network_id', network.id).maybeSingle();
    if (error) throw new Error('Network login unavailable');
    if (!row) return { required: false as const, config: null, revision: '' };
    const { data: payment } = await supabaseAdmin.from('gn_transactions').select('payload').eq('id', data.sessionId).maybeSingle();
    if (!payment || !paidCaptiveAccess(sessionRow.payload as unknown as Session, payment.payload as unknown as Txn, Date.now())) throw new Error('Confirmed live payment and unexpired pass required for network login');
    return { required: true as const, config: captiveSchema.parse(row.config) as CaptiveConfig, revision: row.updated_at };
  });
