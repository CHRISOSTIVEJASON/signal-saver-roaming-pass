import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const Body = z.object({
  response: z.object({
    ExternalReference: z.string().max(100).optional(),
    CheckoutRequestID: z.string().max(100).optional(),
    Reference: z.string().max(100).optional(),
  }).passthrough(),
}).passthrough();

// PayHero callbacks are unsigned: the body only tells us WHICH payment to re-check.
// Activation happens only after PayHero's own status API confirms it was paid.
export const Route = createFileRoute('/api/public/payhero-callback')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = Body.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return new Response('bad request', { status: 400 });
        const r = parsed.data.response;
        const refs = [r.ExternalReference, r.CheckoutRequestID, r.Reference].filter(Boolean) as string[];
        if (!refs.length) return new Response('ok');
        const { supabaseAdmin } = await import('@/integrations/supabase/client.server');
        const { confirmTxn } = await import('@/lib/payments.server');
        const { data: rows } = await supabaseAdmin.from('gn_transactions').select('*').order('created_at', { ascending: false }).limit(300);
        const row = (rows || []).find((t) => { const p = t.payload as any; return p && (refs.includes(p.ref) || refs.includes(p.externalRef)); });
        if (row) { try { await confirmTxn(supabaseAdmin, row); } catch (e) { console.warn('payhero callback', e); } }
        return new Response('ok');
      },
    },
  },
});
