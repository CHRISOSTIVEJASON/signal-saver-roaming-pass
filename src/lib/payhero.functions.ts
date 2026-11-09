import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const creds = z.object({
  apiToken: z.string().max(500).optional().default(""),
  username: z.string().max(200).optional().default(""),
  password: z.string().max(200).optional().default(""),
  channelId: z.string().max(50).optional().default(""),
});

function authHeader(c: z.infer<typeof creds>) {
  if (c.apiToken.trim()) {
    const t = c.apiToken.trim();
    return t.toLowerCase().startsWith("basic ") ? t : `Basic ${t}`;
  }
  return `Basic ${btoa(`${c.username}:${c.password}`)}`;
}

export const initiateStkPush = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    creds
      .extend({
        phone: z.string().regex(/^254[17]\d{8}$/),
        amount: z.number().int().positive().max(1000),
        reference: z.string().max(60),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    try {
      const res = await fetch("https://backend.payhero.co.ke/api/v2/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader(data) },
        body: JSON.stringify({
          amount: data.amount,
          phone_number: data.phone,
          ...(data.channelId && Number(data.channelId) > 0 && String(data.channelId).trim() !== "63902"
            ? { channel_id: Number(data.channelId) }
            : { network_code: "63902" }),
          provider: "m-pesa",
          external_reference: data.reference,
          callback_url: "https://example.com/payhero-callback",
        }),
      });
      const json = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) return { ok: false as const, error: String(json.error_message ?? json.message ?? `HTTP ${res.status}`) };
      return { ok: true as const, reference: String(json.reference ?? json.CheckoutRequestID ?? "") };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Network error" };
    }
  });

export const checkStkStatus = createServerFn({ method: "POST" })
  .inputValidator((d) => creds.extend({ reference: z.string().min(1).max(100) }).parse(d))
  .handler(async ({ data }) => {
    try {
      const res = await fetch(
        `https://backend.payhero.co.ke/api/v2/transaction-status?reference=${encodeURIComponent(data.reference)}`,
        { headers: { Authorization: authHeader(data) } },
      );
      const json = (await res.json().catch(() => ({}))) as any;
      const status = String(json.status ?? "QUEUED").toUpperCase();
      return { status, receipt: String(json.provider_reference ?? json.third_party_reference ?? "") };
    } catch {
      return { status: "QUEUED", receipt: "" };
    }
  });
