"use client";
import { useState } from 'react';
import { useI18n } from '../../components/i18n';

export default function AuthPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [mode, setMode] = useState('login');

  async function submit() {
    const url = (process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001') + (mode === 'login' ? '/login' : '/signup');
    const body = { email, password };
    if (mode === 'signup') body.displayName = displayName;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await resp.json();
    if (json.token) {
      localStorage.setItem('vh_token', json.token);
      window.location.href = '/';
    } else {
      alert(json.error || 'failed');
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '24px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>{mode === 'login' ? t('LoginTitle') : t('SignupTitle')}</h1>
      <div style={{ display: 'grid', gap: 12 }}>
        <input placeholder={t('Email')} value={email} onChange={e => setEmail(e.target.value)} />
        <input type="password" placeholder={t('Password')} value={password} onChange={e => setPassword(e.target.value)} />
        {mode === 'signup' && <input placeholder={t('DisplayName')} value={displayName} onChange={e => setDisplayName(e.target.value)} />}
        <button onClick={submit} style={{ padding: '8px 12px', borderRadius: 8, background: '#111', color: '#fff' }}>{mode === 'login' ? t('Login') : t('CreateAccount')}</button>
        <button onClick={() => setMode(mode === 'login' ? 'signup' : 'login')} style={{ background: 'transparent', border: 'none', color: '#2563eb' }}>
          {mode === 'login' ? t('NoAccount') : t('HaveAccount')}
        </button>
      </div>
    </div>
  );
}
