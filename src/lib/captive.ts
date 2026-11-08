import { z } from 'zod';
import { tick } from './rules';
import type { Session, Txn } from './store';

const field = z.string().trim().min(1).max(80).regex(/^[a-zA-Z0-9_.-]+$/);
export const captiveSchema = z.object({
  kind: z.enum(['voucher', 'pin', 'password']),
  loginUrl: z.string().url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  }, 'Use an HTTPS form submission URL without embedded credentials'),
  username: z.string().max(256).default(''),
  secret: z.string().min(1).max(1024),
  usernameField: field.default('username'),
  secretField: field,
}).superRefine((config, ctx) => {
  if (config.kind === 'password' && !config.username.trim()) ctx.addIssue({ code: 'custom', message: 'Username is required', path: ['username'] });
  if (config.kind === 'password' && config.usernameField === config.secretField) ctx.addIssue({ code: 'custom', message: 'Login fields must be different', path: ['secretField'] });
});
export type CaptiveConfig = z.infer<typeof captiveSchema>;
export function paidCaptiveAccess(session: Session, transaction: Txn, now: number) {
  return session.id === transaction.id && transaction.status === 'Activated' && transaction.mode === 'Live'
    && tick(session.remainingMs, session.lastTick, now, session.online) > 0;
}
export function portalFields(config: CaptiveConfig): Record<string, string> {
  return config.kind === 'password' ? { [config.usernameField]: config.username, [config.secretField]: config.secret } : { [config.secretField]: config.secret };
}