"use client";
import { useEffect, useState } from 'react';

export default function SettingsPage() {
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
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Settings</h1>
      {!user && <div>Please login to manage profile.</div>}
      {user && (
        <div style={{ display: 'grid', gap: 12 }}>
          <div><b>Email:</b> {user.email}</div>
          <div><b>Display Name:</b> {user.display_name || '—'}</div>
          <input placeholder="New display name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
          <button onClick={save} style={{ padding: '8px 12px', borderRadius: 8, background: '#111', color: '#fff', width: 120 }}>Save</button>
        </div>
      )}
    </div>
  );
}

