"use client";
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../components/i18n';
import { API } from '../../lib/api';

const AUTH_BASE = API.auth;

export default function AuthPage() {
  const { t } = useI18n();
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [devToken, setDevToken] = useState('');

  const emailValid = useMemo(() => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), [email]);
  const passwordValid = useMemo(() => String(password).length >= 6, [password]);
  const canSubmit = useMemo(() => {
    if (mode === 'login') return emailValid && passwordValid;
    if (mode === 'signup') return emailValid && passwordValid && (!displayName || displayName.trim().length >= 2);
    if (mode === 'forgot') return emailValid;
    return false;
  }, [mode, emailValid, passwordValid, displayName]);

  async function onSubmit(e){
    e?.preventDefault?.(); if (busy || !canSubmit) return;
    setBusy(true); setErr(''); setOk(''); setDevToken('');
    try {
      if (mode === 'login' || mode === 'signup') {
        const url = AUTH_BASE + (mode === 'login' ? '/login' : '/signup');
        const body = { email, password };
        if (mode === 'signup' && displayName) body.displayName = displayName.trim();
        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await resp.json(); if (!resp.ok || json?.error) throw new Error(json?.error || 'failed');
        if (json.token) {
          localStorage.setItem('vh_token', json.token);
          if (mode === 'signup') { window.location.href = '/onboarding'; return; }
          // Existing user login: decide destination based on profile
          try {
            const r = await fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${json.token}` } });
            const u = await r.json();
            // If email already verified (or any profile exists), go home directly
            if (u && !u.error && (u.email_verified_at || u.display_name || u.profile_extras)) {
              window.location.href = '/';
            } else {
              window.location.href = '/onboarding';
            }
          } catch {
            // Fallback: go home
            window.location.href = '/';
          }
          return;
        }
      } else if (mode === 'forgot') {
        const resp = await fetch(AUTH_BASE + '/password/forgot', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ email }) });
        const j = await resp.json(); if (!resp.ok || j?.error) throw new Error(j?.error || 'failed');
        setOk(t('ResetEmailSent'));
        if (j?.devToken) setDevToken(j.devToken);
      }
    } catch (e) {
      setErr(e?.message || 'failed');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ maxWidth: 560, margin: '36px auto', padding: '0 24px' }}>
      <div style={{ display:'flex', gap:12, marginBottom:16, flexWrap:'wrap' }}>
        <button
          onClick={()=>{ setMode('login'); setErr(''); setOk(''); }}
          className={mode==='login'? 'vh-btn vh-btn-primary vh-btn-lg':'vh-btn vh-btn-outline vh-btn-lg'}
          style={{ minWidth:140 }}
        >
          {t('LoginTitle')}
        </button>
        <button
          onClick={()=>{ setMode('signup'); setErr(''); setOk(''); }}
          className={mode==='signup'? 'vh-btn vh-btn-primary vh-btn-lg':'vh-btn vh-btn-outline vh-btn-lg'}
          style={{ minWidth:140 }}
        >
          {t('SignupTitle')}
        </button>
      </div>
      <form onSubmit={onSubmit} style={{ display:'grid', gap:14, background:'#fff', border:'1px solid #e5e7eb', borderRadius:16, padding:24, boxShadow:'0 12px 32px rgba(15,23,42,0.08)' }}>
        <div style={{ fontSize:28, fontWeight:700 }}>{mode==='login'? t('LoginTitle') : mode==='signup'? t('SignupTitle') : t('ForgotPassword')}</div>
        {(mode==='login'||mode==='signup'||mode==='forgot') && (
          <>
            <input name="email" type="email" placeholder={t('Email')} value={email} onChange={e=>setEmail(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
            {!emailValid && email && <div style={{ color:'#b91c1c', fontSize:12 }}>{t('InvalidEmail')}</div>}
          </>
        )}
        {(mode==='login'||mode==='signup') && (
          <>
            <input name="password" type="password" placeholder={t('Password')} value={password} onChange={e=>setPassword(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
            {!passwordValid && password && <div style={{ color:'#b91c1c', fontSize:12 }}>{t('PasswordMin')}</div>}
          </>
        )}
        {mode==='signup' && (
          <input name="displayName" placeholder={t('DisplayName')} value={displayName} onChange={e=>setDisplayName(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
        )}
        <div style={{ display:'flex', gap:12, alignItems:'center', flexWrap:'wrap' }}>
          <button type="submit" disabled={!canSubmit || busy} className="vh-btn vh-btn-primary vh-btn-lg">
            {mode==='login'? t('Login') : mode==='signup' ? t('CreateAccount') : t('SendResetEmail')}
          </button>
          {mode==='login' && (
            <button type="button" onClick={()=> setMode('forgot')} className="vh-btn vh-btn-link" style={{ padding:'0 6px' }}>{t('ForgotPassword')}?</button>
          )}
        </div>
        {err && <div style={{ color:'#b91c1c' }}>{err}</div>}
        {ok && <div style={{ color:'#166534' }}>{ok} {devToken && (<><span style={{ color:'#334155' }}>DEV token:</span> <code>{devToken}</code> <Link href={`/auth/reset?token=${encodeURIComponent(devToken)}`} style={{ color:'#2563eb' }}>{t('OpenReset')}</Link></>)}</div>}
        {mode==='signup' && (
          <div style={{ fontSize:12, color:'#64748b' }}>{t('SignupEmailHint')}</div>
        )}
      </form>
      <div style={{ marginTop:14, fontSize:14, color:'#64748b' }}>
        <span>{mode==='login' ? t('NoAccount') : t('HaveAccount')}</span>
        <button onClick={()=> setMode(mode==='login'?'signup':'login')} className="vh-btn vh-btn-link" style={{ padding:'0 6px' }}>{mode==='login' ? t('SignupTitle') : t('LoginTitle')}</button>
      </div>
    </div>
  );
}
