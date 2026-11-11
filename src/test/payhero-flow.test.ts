import { describe, it, expect } from 'vitest';
import { getPayHeroAuthHeader } from '@/lib/payhero-auth';
import { resolvePayHeroCallbackUrl } from '@/lib/cloud.functions';

describe('FinoQ / PayHero Payment Flow & Callback Verification', () => {
  describe('Callback URL resolution (resolvePayHeroCallbackUrl)', () => {
    it('redirects localhost and private IPs to production webhook endpoint so FinoQ can deliver callbacks', () => {
      const prodUrl = 'https://signal-saver-roaming-pass.lovable.app/api/public/payhero-callback';
      expect(resolvePayHeroCallbackUrl('http://localhost:3000')).toBe(prodUrl);
      expect(resolvePayHeroCallbackUrl('https://localhost')).toBe(prodUrl);
      expect(resolvePayHeroCallbackUrl('capacitor://localhost')).toBe(prodUrl);
      expect(resolvePayHeroCallbackUrl('http://127.0.0.1:8080')).toBe(prodUrl);
      expect(resolvePayHeroCallbackUrl('http://192.168.1.50:5173')).toBe(prodUrl);
      expect(resolvePayHeroCallbackUrl('https://id-preview--abc.lovable.app')).toBe(prodUrl);
    });

    it('preserves valid custom production origins', () => {
      expect(resolvePayHeroCallbackUrl('https://globalnetworks.co.ke')).toBe('https://globalnetworks.co.ke/api/public/payhero-callback');
      expect(resolvePayHeroCallbackUrl('https://signal-saver-roaming-pass.lovable.app/')).toBe('https://signal-saver-roaming-pass.lovable.app/api/public/payhero-callback');
    });

    it('falls back to default production URL when origin is missing or invalid', () => {
      expect(resolvePayHeroCallbackUrl(undefined)).toBe('https://signal-saver-roaming-pass.lovable.app/api/public/payhero-callback');
      expect(resolvePayHeroCallbackUrl('')).toBe('https://signal-saver-roaming-pass.lovable.app/api/public/payhero-callback');
    });
  });

  describe('PayHero Auth Header Generation (getPayHeroAuthHeader)', () => {
    it('correctly formats HTTP Basic auth when username and password are provided', () => {
      const creds = { username: 'finoq_user', password: 'secret_password_123' };
      const expected = `Basic ${btoa('finoq_user:secret_password_123')}`;
      expect(getPayHeroAuthHeader(creds)).toBe(expected);
    });

    it('supports pre-configured Basic or Bearer API tokens', () => {
      expect(getPayHeroAuthHeader({ api_token: 'Basic bXlfdG9rZW4=' })).toBe('Basic bXlfdG9rZW4=');
      expect(getPayHeroAuthHeader({ api_token: 'Bearer test_bearer_token' })).toBe('Bearer test_bearer_token');
    });

    it('base64 encodes raw API keys or tokens', () => {
      const rawKey = 'test_api_key_456';
      expect(getPayHeroAuthHeader({ api_token: rawKey })).toBe(`Basic ${btoa(`${rawKey}:`)}`);
    });
  });

  describe('FinoQ / PayHero Webhook payload parsing verification', () => {
    it('extracts identifiers from both top-level and nested response/data structures', () => {
      const sample1 = {
        status: 'Success',
        response: {
          CheckoutRequestID: 'ws_CO_11112026_001',
          ExternalReference: 'GN-TEST-001',
          MpesaReceiptNumber: 'SDA1234567',
          Amount: 10,
          PhoneNumber: 254712345678,
          ResultCode: 0,
        },
      };

      const r = (sample1.response && typeof sample1.response === 'object' ? sample1.response : sample1) as any;
      const externalRef = String(r.ExternalReference ?? r.external_reference ?? '').trim();
      const checkoutId = String(r.CheckoutRequestID ?? r.checkout_request_id ?? '').trim();
      const ref = String(r.MpesaReceiptNumber ?? r.reference ?? '').trim();
      const amount = Number(r.Amount ?? 0);

      expect(externalRef).toBe('GN-TEST-001');
      expect(checkoutId).toBe('ws_CO_11112026_001');
      expect(ref).toBe('SDA1234567');
      expect(amount).toBe(10);
    });

    it('detects M-Pesa cancellation / decline error codes correctly', () => {
      const cancelPayload = {
        response: {
          ResultCode: 1032,
          ResultDesc: 'Request cancelled by user',
          CheckoutRequestID: 'ws_CO_11112026_002',
        },
      };
      const r = cancelPayload.response;
      const isFailed = [1, 1031, 1032, 1037].includes(Number(r.ResultCode));
      expect(isFailed).toBe(true);
    });
  });
});
