"use client";
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '../../../components/i18n';

const AUTH_BASE = process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001';

export default function VerifyPage(){
  const { t } = useI18n();
  const sp = useSearchParams();
  const [status, setStatus] = useState('pending'); // pending|ok|error
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const token = sp?.get('token');
    if (!token) { setStatus('error'); setMsg('missing token'); return; }
    (async () => {
      try {
        const resp = await fetch(AUTH_BASE + '/email/verify', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ token }) });
        const j = await resp.json(); if (!resp.ok || j?.error) throw new Error(j?.error||'verify failed');
        setStatus('ok');
      } catch(e){ setStatus('error'); setMsg(e?.message||'verify failed'); }
    })();
  }, [sp]);
  return (
    <div style={{ maxWidth: 460, margin:'24px auto', padding:'0 24px' }}>
      <h1 style={{ fontSize:24, marginBottom:12 }}>{t('VerifyEmail')}</h1>
      {status==='pending' && <div>{t('Loading')}</div>}
      {status==='ok' && <div style={{ color:'#166534' }}>{t('EmailVerifiedOk')||'Email verified!'} <Link href="/auth" style={{ color:'#2563eb' }}>{t('LoginTitle')}</Link></div>}
      {status==='error' && <div style={{ color:'#b91c1c' }}>{msg}</div>}
    </div>
  );
}

