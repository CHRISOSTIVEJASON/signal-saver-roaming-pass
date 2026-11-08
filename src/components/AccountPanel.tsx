import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { lovable } from '@/integrations/lovable';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import '@lovable.dev/cloud-auth-js/styles.css';
export function AccountPanel({ onDone }: { onDone?: () => void }) {
  const [email,setEmail]=useState(''), [password,setPassword]=useState(''), [busy,setBusy]=useState(false), [signup,setSignup]=useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const {error} = signup ? await supabase.auth.signUp({email,password,options:{emailRedirectTo:window.location.origin}}) : await supabase.auth.signInWithPassword({email,password});
    setBusy(false);
    if(error) toast.error(error.message); else if(signup) toast.success('Check your email to confirm your account'); else onDone?.();
  }
  return <div className="space-y-3"><h2 className="text-lg font-semibold">{signup ? 'Create account' : 'Sign in'}</h2>
    <Button variant="outline" className="w-full" onClick={async()=>{ const r=await lovable.auth.signInWithOAuth('google',{redirect_uri:window.location.origin}); if(r.error) toast.error(r.error.message); }}><svg aria-hidden="true" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/><path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/><path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/><path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96z"/></svg>Continue with Google</Button>
    <Button className="lovable-auth-button w-full" onClick={async()=>{ const r=await lovable.auth.signInWithOAuth('lovable',{redirect_uri:window.location.origin}); if(r.error) toast.error(r.error.message); }}>Continue with Lovable</Button>
    <form className="space-y-2" onSubmit={submit}><input aria-label="Email" type="email" required value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email" className="h-11 w-full rounded-md border border-input bg-background px-3"/><input aria-label="Password" type="password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password" className="h-11 w-full rounded-md border border-input bg-background px-3"/><Button disabled={busy} className="w-full">{busy?'Please wait…':signup?'Create account':'Sign in'}</Button></form>
    <div className="flex flex-wrap justify-between gap-2"><Button variant="link" onClick={()=>setSignup(!signup)}>{signup?'Already have an account?':'Create account'}</Button><Button variant="link" onClick={async()=>{ if(!email){toast.error('Enter your email first');return;} const {error}=await supabase.auth.resetPasswordForEmail(email,{redirectTo:window.location.origin+'/reset-password'}); if(error)toast.error(error.message);else toast.success('Check your email for a reset link'); }}>Forgot password?</Button></div>
  </div>;
}
