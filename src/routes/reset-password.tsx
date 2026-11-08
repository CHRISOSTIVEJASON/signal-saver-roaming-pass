import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
export const Route = createFileRoute('/reset-password')({head:()=>({meta:[{title:'Reset password — Global Networks'},{name:'description',content:'Set a new password for your Global Networks account.'},{property:'og:title',content:'Reset password — Global Networks'},{property:'og:description',content:'Securely recover your Global Networks account.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary'}]}),component:ResetPassword});
function ResetPassword(){
  const [password,setPassword]=useState(''),[ready,setReady]=useState(false);
  useEffect(()=>{void supabase.auth.getUser().then(({data})=>setReady(Boolean(data.user)));},[]);
  return <main className="mx-auto max-w-sm space-y-4 px-4 py-16"><h1 className="text-xl font-semibold">Reset your password</h1>{ready?<form className="space-y-3" onSubmit={async e=>{e.preventDefault();const {error}=await supabase.auth.updateUser({password});if(error)toast.error(error.message);else{toast.success('Password updated');window.location.assign('/');}}}><input aria-label="New password" type="password" minLength={8} required value={password} onChange={e=>setPassword(e.target.value)} className="h-11 w-full rounded-md border border-input bg-background px-3"/><Button className="w-full">Save password</Button></form>:<p className="text-muted-foreground">Open the password reset link from your email.</p>}</main>;
}
