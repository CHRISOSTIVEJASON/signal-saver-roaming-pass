import { getPass, DEFAULT_PASSES, type PassOffer, calculateProportionalDuration, ensureUuid, normalizePhone } from './rules';
import type { Session, Txn } from './store';
import { getCompanionPin, generateCompanionPin } from './relay';
import { getPayHeroAuthHeader } from './payhero-auth';

type Admin = (typeof import('@/integrations/supabase/client.server'))['supabaseAdmin'];
const j = (v: unknown) => JSON.parse(JSON.stringify(v));

export async function loadOffers(db: Admin): Promise<PassOffer[]> {
  try {
    const { data } = await db.from('gn_payment_credentials').select('api_token').eq('id', '__gn_offers__').maybeSingle();
    const parsed = data?.api_token ? JSON.parse(data.api_token) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {}
  return [...DEFAULT_PASSES];
}

/** Ask PayHero whether a reference is paid. Never trust an unsigned callback body. */
export async function payHeroStatus(db: Admin, ref: string): Promise<'paid' | 'failed' | 'pending'> {
  let c: any = null;
  try {
    const { data } = await db.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle();
    c = data;
  } catch {}
  if (!c) {
    const apiToken = (process.env.PAYHERO_API_TOKEN || process.env.VITE_PAYHERO_API_TOKEN || '').trim();
    const username = (process.env.PAYHERO_USERNAME || '').trim();
    const password = (process.env.PAYHERO_PASSWORD || '').trim();
    if (apiToken || (username && password)) {
      c = { api_token: apiToken, username, password };
    }
  }
  if (!c) return 'pending';
  const headers = { Authorization: getPayHeroAuthHeader(c), Accept: 'application/json' };
  let res = await fetch(`https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(ref)}`, { headers });
  if (res.status === 404) res = await fetch(`https://backend.payhero.co.ke/api/v2/transaction-status?external_reference=${encodeURIComponent(ref)}`, { headers });
  if (!res.ok) return 'pending';
  const raw = (await res.json().catch(() => ({}))) as any;
  const d = raw?.data && typeof raw.data === 'object' ? raw.data : raw;
  const r = raw?.response ?? {};
  const s = String(d?.status ?? raw?.status ?? '').trim().toUpperCase();
  const code = r?.ResultCode ?? d?.ResultCode ?? raw?.ResultCode ?? d?.result_code;
  if (['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'PAID', 'CONFIRMED'].includes(s) || code === 0 || code === '0' || d?.paymentSuccess === true || d?.is_paid === true) return 'paid';
  if (['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(s) || [1, 1031, 1032, 1037].includes(Number(code))) return 'failed';
  return 'pending';
}

/** Create the session (idempotent) and mark the transaction Activated. */
export async function activateTxn(db: Admin, txn: Txn, userId: string, deviceId?: string): Promise<Session> {
  // If transaction is already Activated, return its active session (or stacked session) without re-calculating or re-stacking
  if (txn.status === 'Activated') {
    const { data: direct } = await db.from('gn_sessions').select('payload').eq('id', txn.id).maybeSingle();
    if (direct?.payload) return direct.payload as unknown as Session;

    const normPhone = normalizePhone(txn.phone || '');
    const { data: activeSessions } = await db.from('gn_sessions').select('*').order('updated_at', { ascending: false }).limit(20);
    const existingActive = (activeSessions || []).find((r: any) => {
      const p = r.payload as any;
      return p && normalizePhone(p.phone || '') === normPhone && (p.remainingMs || 0) > 0;
    });
    if (existingActive?.payload) return existingActive.payload as unknown as Session;
  }

  const { data: existing } = await db.from('gn_sessions').select('payload').eq('id', txn.id).maybeSingle();
  if (existing) {
    if (txn.status !== 'Activated') await db.from('gn_transactions').update({ payload: j({ ...txn, status: 'Activated' }) }).eq('id', txn.id);
    return existing.payload as unknown as Session;
  }
  const offers = await loadOffers(db);
  const isExempted = (txn.mode as any) === 'Exempted';
  const isDemoZero = txn.mode === 'Demo' && (txn.amount === undefined || txn.amount === 0);

  let totalMs = 0;
  let passId = txn.passId;

  if (isExempted || isDemoZero) {
    const pass = getPass(txn.passId, offers);
    totalMs = pass.hours * 3600_000;
    passId = pass.id;
  } else {
    const duration = calculateProportionalDuration(txn.amount, offers, txn.passId);
    if (duration.isUnderpaid) {
      // Check for prior underpayments to aggregate
      const twoHoursAgo = Date.now() - 2 * 3600_000;
      const { data: recentUnderpaid } = await db.from('gn_transactions').select('*').order('created_at', { ascending: false }).limit(30);
      const eligibleUnderpaid = (recentUnderpaid || []).filter((t: any) => {
        if (t.id === txn.id) return false;
        const p = t?.payload;
        if (!p || p.status !== 'Underpaid') return false;
        return normalizePhone(p.phone || '') === normalizePhone(txn.phone || '') && (p.at || 0) >= twoHoursAgo;
      });
      const priorAmount = eligibleUnderpaid.reduce((sum: number, t: any) => sum + (Number(t?.payload?.amount) || 0), 0);
      const combinedAmount = (txn.amount || 0) + priorAmount;
      const combinedDuration = calculateProportionalDuration(combinedAmount, offers, txn.passId);
      if (!combinedDuration.isUnderpaid) {
        for (const up of eligibleUnderpaid) {
          const p = up.payload as any;
          await db.from('gn_transactions').update({
            payload: j({ ...p, status: 'Aggregated', aggregatedInto: txn.id, notes: `Aggregated into ${txn.id} (total KES ${combinedAmount})` })
          }).eq('id', up.id);
        }
        totalMs = combinedDuration.totalMs;
        passId = combinedDuration.passId;
        txn.amount = combinedAmount;
      } else {
        await db.from('gn_transactions').update({ payload: j({ ...txn, status: 'Underpaid', notes: `Underpayment: KES ${txn.amount} received (cumulative KES ${combinedAmount}, minimum KES ${duration.minAmount})` }) }).eq('id', txn.id);
        throw new Error(`Payment of KES ${txn.amount} is below the minimum pass amount of KES ${duration.minAmount}. No internet pass granted.`);
      }
    } else {
      totalMs = duration.totalMs;
      passId = duration.passId;
    }
  }

  const now = Date.now();
  const normPhone = normalizePhone(txn.phone || '');
  const { data: activeSessions } = await db.from('gn_sessions').select('*').order('updated_at', { ascending: false }).limit(20);
  const existingActive = (activeSessions || []).find((r: any) => {
    const p = r.payload as any;
    return p && normalizePhone(p.phone || '') === normPhone && (p.remainingMs || 0) > 0;
  });

  let session: Session;
  if (existingActive) {
    const prev = existingActive.payload as any;
    const stackedRemainingMs = (prev.remainingMs || 0) + totalMs;
    const stackedTotalMs = (prev.totalMs || 0) + totalMs;
    session = {
      ...prev,
      totalMs: stackedTotalMs,
      remainingMs: stackedRemainingMs,
      lastTick: now,
      online: true,
      frozen: false,
    };
    await db.from('gn_sessions').update({
      payload: j({ ...prev, ...session }),
      updated_at: new Date(now).toISOString()
    }).eq('id', existingActive.id);
  } else {
    const companionPin = generateCompanionPin();
    session = { id: txn.id, phone: txn.phone, passId, totalMs, remainingMs: totalMs, lastTick: now, online: true, startedAt: now, companionPin };
    const safeUserId = ensureUuid(userId);
    const effectiveDeviceId = deviceId || (txn as any).deviceId || null;
    const { error } = await db.from('gn_sessions').upsert({
      id: txn.id, user_id: safeUserId,
      payload: j({ ...session, bound_device_id: effectiveDeviceId, companion_pin: companionPin, paired_companion_id: null }),
    }, { onConflict: 'id' });
    if (error) throw new Error('Could not record your pass. Please try again.');
  }
  await db.from('gn_transactions').update({ payload: j({ ...txn, status: 'Activated', passId }) }).eq('id', txn.id);
  return session;
}

export async function confirmTxn(db: Admin, row: { id: string; user_id: string; payload: unknown }, deviceId?: string): Promise<{ pending: boolean; session: Session | null }> {
  const txn = row.payload as Txn;
  if (txn.status === 'Failed') throw new Error('Payment was cancelled or failed');
  if (txn.mode === 'Live' && txn.status !== 'Activated') {
    let st = await payHeroStatus(db, txn.ref);
    if (st === 'pending' && (txn as any).externalRef && (txn as any).externalRef !== txn.ref) {
      st = await payHeroStatus(db, (txn as any).externalRef);
    }
    if (st === 'pending' && (txn as any).checkoutRequestId && (txn as any).checkoutRequestId !== txn.ref) {
      st = await payHeroStatus(db, (txn as any).checkoutRequestId);
    }
    if (st === 'failed') {
      await db.from('gn_transactions').update({ payload: j({ ...txn, status: 'Failed' }) }).eq('id', txn.id);
      throw new Error('Payment was cancelled or declined on your phone');
    }
    if (st === 'pending') return { pending: true, session: null };
  }
  const effectiveDeviceId = deviceId || (txn as any).deviceId || undefined;
  return { pending: false, session: await activateTxn(db, txn, row.user_id, effectiveDeviceId) };
}
