"use client";
import { useEffect, useState } from 'react';
import { useI18n } from '../../components/i18n';

export default function SettingsPage() {
  const { t } = useI18n();
  const [user, setUser] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState(null);

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    setToken(t);
    if (!t) return;
    fetch((process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001') + '/me', { headers: { Authorization: `Bearer ${t}` } })
      .then(r => r.json()).then(setUser);
  }, []);

  async function save() {
    if (!token) return;
    const resp = await fetch((process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001') + '/me', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ displayName })
    });
    const u = await resp.json();
    setUser(u);
  }

  return (
    <div style={{ maxWidth: 720, margin: '24px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('ProfileTitle')}</h1>
      {!user && <div>{t('PleaseLoginManage')}</div>}
      {user && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:48, height:48, borderRadius:'9999px', background:'#111', color:'#fff', display:'grid', placeItems:'center', fontSize:18 }}>
              {(user.display_name || user.email || 'U').trim()[0]?.toUpperCase?.() || 'U'}
            </div>
            <div>
              <div style={{ fontWeight:600 }}>{user.display_name || '—'}</div>
              <div style={{ color:'#64748b', fontSize:13 }}>{user.email}</div>
            </div>
          </div>
          <label style={{ color:'#475569' }}>{t('DisplayName')}</label>
          <input placeholder={t('DisplayName')} value={displayName} onChange={e => setDisplayName(e.target.value)} />
          <div>
            <button onClick={save} className="vh-btn vh-btn-primary" style={{ width:120 }}>{t('Save')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
