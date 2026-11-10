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
        const billRef = String(r.BillRefNumber ?? r.billrefnumber ?? r.bill_ref_number ?? r.AccountNumber ?? r.account_number ?? r.accountNumber ?? r.Account ?? r.account ?? raw.BillRefNumber ?? raw.account_number ?? '').trim();

        let ticketPart = '';
        if (billRef.includes('#')) {
          ticketPart = billRef.split('#')[1]?.trim() || '';
        }

        const refs = [externalRef, checkoutId, ref, billRef, ticketPart].filter(Boolean);
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const { confirmTxn, activateTxn, loadOffers } = await import('@/lib/payments.server');

        // 1. If matching an existing pending transaction
        if (refs.length > 0) {
          const { data: rows } = await supabaseAdmin.from('gn_transactions').select('*').order('created_at', { ascending: false }).limit(300);
          const row = (rows || []).find((t) => {
            const p = t.payload as any;
            if (!p) return false;
            return (
              refs.includes(p.ref) ||
              refs.includes(p.externalRef) ||
              refs.includes(p.id) ||
              refs.includes(p.checkoutRequestId) ||
              (p.accountNumber && refs.some((rStr: string) => rStr && (p.accountNumber.toUpperCase().includes(rStr.toUpperCase()) || rStr.toUpperCase().includes(p.accountNumber.toUpperCase()))))
            );
          });
          const cbStatus = String(r.Status ?? r.status ?? raw.status ?? '').toUpperCase();
          const cbResultCode = r?.ResultCode ?? r?.result_code ?? raw?.ResultCode ?? raw?.result_code;
          const cbResponseCode = r?.ResponseCode ?? r?.response_code ?? raw?.ResponseCode ?? raw?.response_code;
          const isVerifiedSuccess =
            ['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'COMPLETE', 'PAID', 'CONFIRMED'].includes(cbStatus) ||
            cbResultCode === 0 ||
            cbResultCode === '0' ||
            cbResponseCode === 0 ||
            cbResponseCode === '0' ||
            r?.paymentSuccess === true ||
            r?.is_paid === true ||
            raw?.success === true;

          if (row) {
            try {
              const p = row.payload as any;
              if (isVerifiedSuccess) {
                // Immediate activation on verified success to eliminate PayHero timing race condition
                await activateTxn(supabaseAdmin, p, row.user_id, p?.deviceId);
              } else {
                await confirmTxn(supabaseAdmin, row, p?.deviceId);
              }
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
          const twoHoursAgo = Date.now() - 2 * 3600_000;
          
          // Glitch 5 / Recommendation 4: Cumulative Underpayment Aggregation (Payment Ledger)
          const { data: recentUnderpaid } = await supabaseAdmin
            .from('gn_transactions')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(30);

          const eligibleUnderpaid = (recentUnderpaid || []).filter((t: any) => {
            const p = t?.payload;
            if (!p || p.status !== 'Underpaid') return false;
            const tp = normalizePhone(p.phone || '');
            const matchesPhone = tp === phone;
            const matchesBill = billRef && p.accountNumber && (p.accountNumber.includes(billRef) || billRef.includes(p.accountNumber));
            const matchesTicket = ticketPart && p.accountNumber && p.accountNumber.includes(ticketPart);
            return (matchesPhone || matchesBill || matchesTicket) && (p.at || 0) >= twoHoursAgo;
          });

          const priorAmount = eligibleUnderpaid.reduce((sum: number, t: any) => sum + (Number(t?.payload?.amount) || 0), 0);
          const combinedAmount = amount + priorAmount;
          const duration = calculateProportionalDuration(combinedAmount, offers);
          const txnId = crypto.randomUUID();
          const txnRef = ref || externalRef || ('PB' + txnId.replaceAll('-', '').slice(0, 10).toUpperCase());

          if (duration.isUnderpaid) {
            // Record underpayment with cumulative total note
            await supabaseAdmin.from('gn_transactions').insert({
              id: txnId,
              user_id: txnId,
              payload: {
                id: txnId,
                ref: txnRef,
                phone,
                amount: combinedAmount,
                passId: duration.passId,
                at: Date.now(),
                status: 'Underpaid',
                mode: 'Live',
                notes: `Underpayment of KES ${amount} (cumulative KES ${combinedAmount} received; minimum KES ${duration.minAmount}). No internet pass granted.`,
              },
            });
          } else {
            // Cumulative threshold met! Mark prior underpayments as aggregated
            for (const up of eligibleUnderpaid) {
              const p = up.payload as any;
              await supabaseAdmin.from('gn_transactions').update({
                payload: {
                  ...p,
                  status: 'Aggregated',
                  notes: `Aggregated into payment ${txnId} (combined KES ${combinedAmount})`,
                  aggregatedInto: txnId,
                }
              }).eq('id', up.id);
            }
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

            // Attempt to bind to device that recently attempted payment or queried for this phone or ticket
            let boundDeviceId: string | null = null;
            try {
              const { data: recentRows } = await supabaseAdmin.from('gn_transactions').select('payload').order('created_at', { ascending: false }).limit(50);
              const matched = (recentRows || []).find((t: any) => {
                const p = t?.payload;
                if (!p || !p.deviceId) return false;
                if (normalizePhone(p.phone || '') === phone) return true;
                if (billRef && p.accountNumber && (p.accountNumber.includes(billRef) || billRef.includes(p.accountNumber))) return true;
                if (ticketPart && p.accountNumber && p.accountNumber.includes(ticketPart)) return true;
                return false;
              });
              if (matched) boundDeviceId = (matched.payload as any).deviceId;
            } catch {}

            await supabaseAdmin.from('gn_sessions').upsert({
              id: txnId,
              user_id: txnId,
              payload: {
                ...session,
                bound_device_id: boundDeviceId,
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
