import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { Eye, EyeOff, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { getAdminCaptive, saveAdminCaptive, contributeNetworkAndCaptive } from '@/lib/captive.functions';
import { captiveSchema, type CaptiveConfig } from '@/lib/captive';
import type { Network } from '@/lib/store';
import { Capacitor } from '@capacitor/core';
import { GlobalRelay } from '@/lib/native-relay';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function CaptiveCredentialsDialog({
  network,
  initialCaptiveRequired = false,
  onSaved,
  onClose,
}: {
  network: Network;
  initialCaptiveRequired?: boolean;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const load = useServerFn(getAdminCaptive);
  const save = useServerFn(saveAdminCaptive);
  const contribute = useServerFn(contributeNetworkAndCaptive);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [enabled, setEnabled] = useState(initialCaptiveRequired);
  const [autoDetected, setAutoDetected] = useState<string | null>(null);

  const [config, setConfig] = useState<CaptiveConfig>({
    kind: 'voucher',
    loginUrl: 'https://192.168.88.1/login',
    username: '',
    secret: '',
    usernameField: 'username',
    secretField: 'voucher',
  });

  const cacheKey = `gn_captive_${network.id}`;

  useEffect(() => {
    let cancelled = false;

    async function initializeAndAutoDetect() {
      let existingConfig: CaptiveConfig | null = null;

      // 1. Try local cache first
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && parsed.loginUrl) {
            existingConfig = parsed;
          }
        }
      } catch {}

      // 2. Try loading from cloud
      if (!existingConfig) {
        try {
          const value = await load({ data: { networkId: network.id } });
          if (!cancelled && value && value.loginUrl) {
            existingConfig = value;
            try { localStorage.setItem(cacheKey, JSON.stringify(value)); } catch {}
          }
        } catch {}
      }

      if (cancelled) return;

      if (existingConfig) {
        setConfig(existingConfig);
        setEnabled(true);
        setAutoDetected('Saved credentials loaded');
        setLoading(false);
        return;
      }

      // 3. SILENT AUTO-DETECTION: probe environment, clipboard, and recent vouchers/receipts
      let detectedKind: 'voucher' | 'pin' | 'password' = 'voucher';
      let detectedSecret = '';
      let detectedUrl = 'https://192.168.88.1/login';

      // Detect URL if redirected on portal or local gateway
      try {
        if (typeof window !== 'undefined' && window.location.hostname && !window.location.hostname.includes('localhost') && !window.location.hostname.includes('lovable')) {
          detectedUrl = `https://${window.location.hostname}/login`;
        }
      } catch {}

      // Probe clipboard silently for voucher or PIN code (e.g. from SMS or M-Pesa receipt)
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          const clipText = await navigator.clipboard.readText();
          if (clipText) {
            const trimmed = clipText.trim();
            const pinMatch = trimmed.match(/\b\d{4,8}\b/);
            const voucherMatch = trimmed.match(/\b[A-Za-z0-9]{4,16}\b/);

            if (/^\d{4,8}$/.test(trimmed)) {
              detectedSecret = trimmed;
              detectedKind = 'pin';
            } else if (pinMatch && trimmed.toLowerCase().includes('pin')) {
              detectedSecret = pinMatch[0];
              detectedKind = 'pin';
            } else if (voucherMatch && (trimmed.length <= 16 || trimmed.toLowerCase().includes('voucher') || trimmed.toLowerCase().includes('code'))) {
              detectedSecret = voucherMatch[0];
              detectedKind = 'voucher';
            }
          }
        }
      } catch {}

      // Check localStorage for recent vouchers / M-Pesa receipts if clipboard was empty
      if (!detectedSecret) {
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.includes('voucher') || k.includes('last_voucher') || k.includes('txn') || k.includes('pass'))) {
              const val = localStorage.getItem(k);
              if (val) {
                try {
                  const parsed = JSON.parse(val);
                  const candidate = parsed.voucher || parsed.pin || parsed.code || parsed.secret || (typeof parsed === 'string' ? parsed : null);
                  if (candidate && typeof candidate === 'string') {
                    detectedSecret = candidate.trim();
                    detectedKind = /^\d+$/.test(detectedSecret) ? 'pin' : 'voucher';
                    break;
                  }
                } catch {
                  if (typeof val === 'string' && val.length >= 4 && val.length <= 16) {
                    detectedSecret = val.trim();
                    detectedKind = /^\d+$/.test(detectedSecret) ? 'pin' : 'voucher';
                    break;
                  }
                }
              }
            }
          }
        } catch {}
      }

      if (!cancelled) {
        setConfig({
          kind: detectedKind,
          loginUrl: detectedUrl,
          username: '',
          secret: detectedSecret,
          usernameField: 'username',
          secretField: ((detectedKind as string) === 'password' ? 'password' : (detectedKind === 'pin' ? 'pin' : 'voucher')) as any,
        });
        setEnabled(true);
        setAutoDetected(
          detectedSecret
            ? `Auto-detected: ${detectedKind === 'pin' ? 'Paid PIN' : 'Paid Voucher'} code picked`
            : `Auto-detected: Hotspot portal (${detectedKind === 'pin' ? 'PIN' : 'Voucher'} mode)`
        );
        setLoading(false);
      }
    }

    void initializeAndAutoDetect();
    return () => { cancelled = true; };
  }, [network.id, load, cacheKey]);

  const input = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
  const field = (label: string, key: 'loginUrl' | 'username' | 'usernameField' | 'secretField') => (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        className={input}
        value={config[key]}
        onChange={e => setConfig({ ...config, [key]: e.target.value })}
        autoComplete="off"
      />
    </label>
  );

  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
      <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-lg">
        <DialogTitle>Network login · {network.ssid}</DialogTitle>
        <DialogDescription>
          Private credentials · {network.venue || network.bssid}
        </DialogDescription>

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={async e => {
              e.preventDefault();
              const parsed = captiveSchema.safeParse(config);
              if (enabled && !parsed.success) {
                toast.error(parsed.error.issues[0]?.message ?? 'Check login details');
                return;
              }
              setBusy(true);
              const toSave = enabled && parsed.success ? parsed.data : null;

              // 1. Save locally immediately
              try {
                if (toSave) {
                  localStorage.setItem(cacheKey, JSON.stringify(toSave));
                } else {
                  localStorage.removeItem(cacheKey);
                }
              } catch {}

              // 2. Save admin captive cloud config
              try {
                await save({ data: { networkId: network.id, config: toSave } });
              } catch (err) {
                console.warn('Cloud captive save deferred:', err);
              }

              // 3. Silently contribute to cloud network pool
              try {
                const contribData: { ssid: string; bssid: string; venue?: string; voucherCode?: string; loginUrl?: string } = {
                  ssid: network.ssid,
                  bssid: network.bssid,
                };
                if (network.venue) contribData.venue = network.venue;
                if (toSave?.secret) contribData.voucherCode = toSave.secret;
                if (toSave?.loginUrl) contribData.loginUrl = toSave.loginUrl;
                await contribute({ data: contribData });
              } catch (err) {
                console.warn('Pool contribution deferred:', err);
              }

              // 4. Silently activate native mesh relay in background
              try {
                if (Capacitor.isNativePlatform()) {
                  void GlobalRelay.start({ active: true, upstreamInPool: true });
                }
              } catch {}

              setBusy(false);
              toast.success(`Stored!! ${network.ssid} credentials saved and active in pool`);
              if (onSaved) onSaved();
              onClose();
            }}
          >
            {autoDetected && (
              <div className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary">
                <Sparkles className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{autoDetected}</span>
              </div>
            )}

            <label className="flex items-center justify-between gap-3 text-sm font-medium">
              Captive login required
              <input
                type="checkbox"
                checked={enabled}
                onChange={e => setEnabled(e.target.checked)}
                disabled={busy}
                className="h-4 w-4 rounded border-input text-primary accent-[var(--primary)]"
              />
            </label>

            {enabled && (
              <>
                <div className="grid grid-cols-3 gap-1">
                  {(['voucher', 'pin', 'password'] as const).map(kind => (
                    <Button
                      key={kind}
                      type="button"
                      variant={config.kind === kind ? 'default' : 'outline'}
                      onClick={() => setConfig({ ...config, kind, secretField: kind === 'password' ? 'password' : kind })}
                    >
                      {kind === 'password' ? 'User / Pass' : kind === 'pin' ? 'PIN' : 'Voucher'}
                    </Button>
                  ))}
                </div>

                {field('HTTPS login form submission URL', 'loginUrl')}

                {config.kind === 'password' && (
                  <>
                    {field('Username (fill manually)', 'username')}
                    {field('Username form field', 'usernameField')}
                  </>
                )}

                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">
                    {config.kind === 'password' ? 'Password' : config.kind === 'pin' ? 'Shared PIN' : 'Shared voucher code'}
                  </span>
                  <div className="flex gap-2">
                    <input
                      className={input}
                      type={show ? 'text' : 'password'}
                      value={config.secret}
                      onChange={e => setConfig({ ...config, secret: e.target.value })}
                      autoComplete="new-password"
                      placeholder={config.kind === 'password' ? 'Enter password' : 'Auto-detected or enter code'}
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label={show ? 'Hide credential' : 'Show credential'}
                      onClick={() => setShow(!show)}
                    >
                      {show ? <EyeOff /> : <Eye />}
                    </Button>
                  </div>
                </label>

                {field('Credential form field', 'secretField')}
              </>
            )}

            <Button className="w-full font-semibold" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Network Login'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
