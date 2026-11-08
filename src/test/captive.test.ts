import { describe, expect, it } from 'vitest';
import { captiveSchema, paidCaptiveAccess, portalFields } from '@/lib/captive';
import type { Session, Txn } from '@/lib/store';
const session: Session = { id: 'paid', phone: '254700000000', passId: 'p15', totalMs: 54000000, remainingMs: 1000, lastTick: 100, online: false, startedAt: 100 };
const txn: Txn = { id: 'paid', phone: session.phone, amount: 10, passId: 'p15', ref: 'ref', at: 100, status: 'Activated', mode: 'Live' };
describe('Private shared portal login', () => {
  it('releases access only after an approved live payment', () => {
    expect(paidCaptiveAccess(session, txn, 200)).toBe(true);
    expect(paidCaptiveAccess(session, { ...txn, status: 'Pending' }, 200)).toBe(false);
    expect(paidCaptiveAccess(session, { ...txn, mode: 'Demo' }, 200)).toBe(false);
    expect(paidCaptiveAccess(session, { ...txn, id: 'other' }, 200)).toBe(false);
  });
  it('does not release credentials for expired pass time', () => {
    expect(paidCaptiveAccess({ ...session, online: true }, txn, 1100)).toBe(false);
    expect(paidCaptiveAccess({ ...session, remainingMs: 0 }, txn, 200)).toBe(false);
  });
  it('supports shared vouchers, PINs, and username/password fields', () => {
    const base = { loginUrl: 'https://portal.example/login', secret: 'test-only', secretField: 'voucher' };
    expect(portalFields(captiveSchema.parse({ ...base, kind: 'voucher' }))).toEqual({ voucher: 'test-only' });
    expect(portalFields(captiveSchema.parse({ ...base, kind: 'pin', secretField: 'pin' }))).toEqual({ pin: 'test-only' });
    expect(portalFields(captiveSchema.parse({ ...base, kind: 'password', username: 'test-user', secretField: 'password' }))).toEqual({ username: 'test-user', password: 'test-only' });
  });
  it('rejects insecure destinations and invalid password mappings', () => {
    const base = { kind: 'voucher', secret: 'test-only', secretField: 'voucher' };
    expect(captiveSchema.safeParse({ ...base, loginUrl: 'http://portal.example/login' }).success).toBe(false);
    expect(captiveSchema.safeParse({ ...base, loginUrl: 'https://user:pass@portal.example/login' }).success).toBe(false);
    expect(captiveSchema.safeParse({ ...base, kind: 'password', loginUrl: 'https://portal.example/login' }).success).toBe(false);
  });
});