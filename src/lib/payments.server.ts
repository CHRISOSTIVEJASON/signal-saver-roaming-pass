import { getPass, DEFAULT_PASSES, type PassOffer, calculateProportionalDuration, ensureUuid } from './rules';
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
  const { data: c } = await db.from('gn_payment_credentials').select('*').eq('id', 'global').maybeSingle();
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
      await db.from('gn_transactions').update({ payload: j({ ...txn, status: 'Underpaid', notes: `Underpayment: KES ${txn.amount} received (minimum KES ${duration.minAmount})` }) }).eq('id', txn.id);
      throw new Error(`Payment of KES ${txn.amount} is below the minimum pass amount of KES ${duration.minAmount}. No internet pass granted.`);
    }
    totalMs = duration.totalMs;
    passId = duration.passId;
  }

  const now = Date.now();
  const companionPin = generateCompanionPin();
  const session: Session = { id: txn.id, phone: txn.phone, passId, totalMs, remainingMs: totalMs, lastTick: now, online: true, startedAt: now, companionPin };
  const safeUserId = ensureUuid(userId);
  const { error } = await db.from('gn_sessions').upsert({
    id: txn.id, user_id: safeUserId,
    payload: j({ ...session, bound_device_id: deviceId || null, companion_pin: companionPin, paired_companion_id: null }),
  }, { onConflict: 'id' });
  if (error) throw new Error('Could not record your pass. Please try again.');
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
  return { pending: false, session: await activateTxn(db, txn, row.user_id, deviceId) };
}
