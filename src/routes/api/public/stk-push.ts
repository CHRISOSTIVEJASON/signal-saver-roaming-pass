import { createFileRoute } from '@tanstack/react-router';
import { normalizePhone } from '@/lib/rules';

export const Route = createFileRoute('/api/public/stk-push')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.json().catch(() => null);
        if (!raw || typeof raw !== 'object') {
          return new Response(JSON.stringify({ error: 'Invalid JSON request body' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const phone = normalizePhone(String(raw.phone || raw.phone_number || raw.msisdn || ''));
        if (!phone) {
          return new Response(JSON.stringify({ error: 'Valid Safaricom phone number required (07… or 01…)' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const passId = String(raw.passId || 'p15');
        const deviceId = raw.deviceId ? String(raw.deviceId) : undefined;

        try {
          const { startCloudPayment } = await import('@/lib/cloud.functions');
          const res = await startCloudPayment({
            data: {
              phone,
              passId,
              ...(deviceId ? { deviceId } : {}),
            },
          });
          return new Response(JSON.stringify({ success: true, CheckoutRequestID: res.ref, ...res }), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: any) {
          return new Response(JSON.stringify({ error: err?.message || 'Payment processing failed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    },
  },
});
