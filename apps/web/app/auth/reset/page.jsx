"use client";
import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useI18n } from '../../../components/i18n';
import { API } from '../../../lib/api';

const AUTH_BASE = API.auth;

export default function ResetPage(){
  const { t } = useI18n();
  const sp = useSearchParams();
  const [token, setToken] = useState('');
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => { const tkn = sp?.get('token'); if (tkn) setToken(tkn); }, [sp]);

  async function submit(e){
    e.preventDefault(); if (busy) return;
    setErr(''); setOk('');
    if (!token) { setErr('missing token'); return; }
    if (!p1 || p1.length < 6) { setErr(t('PasswordMin')); return; }
    if (p1 !== p2) { setErr(t('PasswordsDontMatch')||'Passwords do not match'); return; }
    setBusy(true);
    try {
      const resp = await fetch(AUTH_BASE + '/password/reset', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ token, newPassword: p1 }) });
      const j = await resp.json(); if (!resp.ok || j?.error) throw new Error(j?.error||'reset failed');
      setOk(t('PasswordResetOk')||'Password reset. You can login now.');
    } catch(e){ setErr(e?.message || 'reset failed'); } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 460, margin:'24px auto', padding:'0 24px' }}>
      <h1 style={{ fontSize:24, marginBottom:12 }}>{t('ResetPassword')||'Reset password'}</h1>
      <form onSubmit={submit} style={{ display:'grid', gap:12, background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16 }}>
        <input type="password" placeholder={t('NewPassword')||'New password'} value={p1} onChange={e=>setP1(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
        <input type="password" placeholder={t('ConfirmPassword')||'Confirm password'} value={p2} onChange={e=>setP2(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
        <button disabled={busy} className="vh-btn vh-btn-primary">{t('ResetPassword')||'Reset password'}</button>
        {err && <div style={{ color:'#b91c1c' }}>{err}</div>}
        {ok && <div style={{ color:'#166534' }}>{ok} <Link href="/auth" style={{ color:'#2563eb' }}>{t('LoginTitle')}</Link></div>}
      </form>
    </div>
  );
}
