import { useEffect, useState } from 'react';
import { useServerFn } from '@tanstack/react-start';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { getAdminCaptive, saveAdminCaptive } from '@/lib/captive.functions';
import { captiveSchema, type CaptiveConfig } from '@/lib/captive';
import type { Network } from '@/lib/store';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function CaptiveCredentialsDialog({ network, onClose }: { network: Network; onClose: () => void }) {
  const load = useServerFn(getAdminCaptive), save = useServerFn(saveAdminCaptive);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [show, setShow] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState<CaptiveConfig>({
    kind: 'voucher',
    loginUrl: '',
    username: '',
    secret: '',
    usernameField: 'username',
    secretField: 'voucher'
  });

  const cacheKey = `gn_captive_${network.id}`;

  useEffect(() => {
    let cancelled = false;
    // Load from local cache first so it's instantly available even offline / on captive portal
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed) {
          setConfig(parsed);
          setEnabled(true);
        }
      }
    } catch {}

    // Then try loading from cloud server function without failing the form
    void load({ data: { networkId: network.id } })
      .then(value => {
        if (!cancelled && value) {
          setConfig(value);
          setEnabled(true);
          try { localStorage.setItem(cacheKey, JSON.stringify(value)); } catch {}
        }
      })
      .catch(() => {
        // Silently tolerate if offline or captive network blocks internet
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

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
        <DialogDescription>Private credentials · {network.venue || network.bssid}</DialogDescription>
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
              // Always save locally immediately so captive portal credentials persist
              try {
                if (toSave) {
                  localStorage.setItem(cacheKey, JSON.stringify(toSave));
                } else {
                  localStorage.removeItem(cacheKey);
                }
              } catch {}

              // Also attempt cloud save
              try {
                await save({ data: { networkId: network.id, config: toSave } });
              } catch (err) {
                console.warn('Cloud captive save deferred/offline:', err);
              } finally {
                setBusy(false);
                toast.success('Network login saved');
                onClose();
              }
            }}
          >
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
                    {field('Username', 'username')}
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
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save network login'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
