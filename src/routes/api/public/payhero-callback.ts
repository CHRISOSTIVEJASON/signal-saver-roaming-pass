import { createFileRoute } from '@tanstack/react-router';
import { normalizePhone, calculateProportionalDuration } from '@/lib/rules';

// PayHero callbacks are processed for both STK pushes and direct Paybill payments (756756 / 553125#13205).
export const Route = createFileRoute('/api/public/payhero-callback')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.json().catch(() => null);
        if (!raw || typeof raw !== 'object') return new Response('bad request', { status: 400 });

        const r = (raw.response && typeof raw.response === 'object' ? raw.response : raw) as any;
        const externalRef = String(r.ExternalReference ?? r.external_reference ?? raw.external_reference ?? '').trim();
        const checkoutId = String(r.CheckoutRequestID ?? r.checkout_request_id ?? raw.CheckoutRequestID ?? '').trim();
        const ref = String(r.Reference ?? r.reference ?? r.MpesaReceiptNumber ?? r.mpesa_reference ?? raw.Reference ?? raw.reference ?? '').trim();

        const refs = [externalRef, checkoutId, ref].filter(Boolean);
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const { confirmTxn, loadOffers } = await import('@/lib/payments.server');

        // 1. If matching an existing pending transaction
        if (refs.length > 0) {
          const { data: rows } = await supabaseAdmin.from('gn_transactions').select('*').order('created_at', { ascending: false }).limit(300);
          const row = (rows || []).find((t) => {
            const p = t.payload as any;
            return p && (refs.includes(p.ref) || refs.includes(p.externalRef) || refs.includes(p.id));
          });
          if (row) {
            try {
              await confirmTxn(supabaseAdmin, row);
              return new Response('ok');
            } catch (e) {
              console.warn('payhero callback existing txn confirmation error:', e);
            }
          }
        }

        // 2. Direct Paybill / C2B notification (e.g. to Paybill 756756, Account 553125#13205)
        const rawPhone = String(r.Phone ?? r.phone ?? r.PhoneNumber ?? r.phone_number ?? r.MSISDN ?? raw.phone ?? '');
        const phone = normalizePhone(rawPhone);
        const amount = Number(r.Amount ?? r.amount ?? raw.amount ?? 0);
        const status = String(r.Status ?? r.status ?? raw.status ?? '').toUpperCase();
        const isFailed = ['FAILED', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status);

        if (phone && amount > 0 && !isFailed) {
          const offers = await loadOffers(supabaseAdmin);
          const duration = calculateProportionalDuration(amount, offers);
          const txnId = crypto.randomUUID();
          const txnRef = ref || externalRef || ('PB' + txnId.replaceAll('-', '').slice(0, 10).toUpperCase());

          if (duration.isUnderpaid) {
            // Record underpayment, do NOT grant internet
            await supabaseAdmin.from('gn_transactions').insert({
              id: txnId,
              user_id: txnId,
              payload: {
                id: txnId,
                ref: txnRef,
                phone,
                amount,
                passId: duration.passId,
                at: Date.now(),
                status: 'Underpaid',
                mode: 'Live',
                notes: `Underpayment of KES ${amount} (minimum KES ${duration.minAmount}). No internet pass granted.`,
              },
            });
          } else {
            // Grant access with exact proportional duration rounded to nearest second
            const now = Date.now();
            const { generateCompanionPin } = await import('@/lib/relay');
            const companionPin = generateCompanionPin();
            const session = {
              id: txnId,
              phone,
              passId: duration.passId,
              totalMs: duration.totalMs,
              remainingMs: duration.totalMs,
              lastTick: now,
              online: true,
              startedAt: now,
              companionPin,
            };

            await supabaseAdmin.from('gn_transactions').insert({
              id: txnId,
              user_id: txnId,
              payload: {
                id: txnId,
                ref: txnRef,
                phone,
                amount,
                passId: duration.passId,
                at: now,
                status: 'Activated',
                mode: 'Live',
                durationHours: duration.hours,
                durationMs: duration.totalMs,
              },
            });

            await supabaseAdmin.from('gn_sessions').upsert({
              id: txnId,
              user_id: txnId,
              payload: {
                ...session,
                bound_device_id: null,
                companion_pin: companionPin,
                paired_companion_id: null,
              },
              updated_at: new Date().toISOString(),
            }, { onConflict: 'id' });
          }
        }

        return new Response('ok');
      },
    },
  },
});
