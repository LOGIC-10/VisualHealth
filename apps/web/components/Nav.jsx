"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from './i18n';
import { API } from '../lib/api';

const AUTH_BASE = API.auth;
const MEDIA_BASE = API.media;

export default function Nav({ initialLang = 'en', initialTheme = 'light' }) {
  const { t } = useI18n();
  const [token, setToken] = useState(() => { try { return localStorage.getItem('vh_token'); } catch { return null; } });
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(initialTheme); // 'light' | 'dark'
  const [lang, setLang] = useState(initialLang); // 'en' | 'zh'
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    setMounted(true);
    let tkn = token;
    if (!tkn) { try { tkn = localStorage.getItem('vh_token'); if (tkn) setToken(tkn); } catch {} }
    // Use cached user if available to avoid flicker between pages
    try { const cached = window.__vh_user; if (cached && cached.id) setUser(cached); } catch {}
    if (!tkn) return;
    fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${tkn}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(u => { if (u && !u.error) { setUser(u); try { window.__vh_user = u; } catch {} } })
      .catch(() => {});
  }, []);

  // Listen for global user updates (e.g., profile save / avatar change)
  useEffect(() => {
    function onUserChange(ev){ const u = ev?.detail; if (u && u.id) { setUser(u); try { window.__vh_user = u; } catch {} } }
    window.addEventListener('vh_user_change', onUserChange);
    return () => window.removeEventListener('vh_user_change', onUserChange);
  }, []);

  // Keep token in sync across tabs/windows
  useEffect(() => {
    function onStorage(ev){ if (ev.key === 'vh_token') { const v = ev.newValue || null; setToken(v); if (!v) { setUser(null); try { window.__vh_user = null; } catch {} } } }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    function onDoc(e){ if (!menuRef.current) return; if (!menuRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  // apply theme/lang to document + cookies
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.setAttribute('data-lang', lang);
    }
    try { document.cookie = `vh_theme=${theme}; path=/; samesite=lax; max-age=${60*60*24*365}`; } catch {}
    try { document.cookie = `vh_lang=${lang}; path=/; samesite=lax; max-age=${60*60*24*365}`; } catch {}
    try { window.dispatchEvent(new CustomEvent('vh_lang_change', { detail: lang })); } catch {}
  }, [theme, lang]);

  function logout(){
    localStorage.removeItem('vh_token');
    window.location.href = '/';
  }

  const initials = (user?.display_name || user?.email || 'U').trim()[0]?.toUpperCase?.() || 'U';
  const avatarId = user?.avatar_media_id || null;
  const isDark = theme === 'dark';
  const T = t;

  return (
    <nav style={{ position: 'sticky', top: 0, zIndex: 10, background: isDark ? 'rgba(11,18,32,0.92)' : 'rgba(255,255,255,0.92)', borderBottom: `1px solid ${isDark ? '#283548' : '#e5e7eb'}`, boxShadow: isDark ? '0 1px 8px rgba(0,0,0,0.25)' : '0 1px 8px rgba(0,0,0,0.06)', display: 'flex', alignItems:'center', justifyContent:'space-between', gap: 16, padding: '14px 24px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:18 }}>
        <Link href="/" style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', textDecoration: 'none', color: isDark ? '#f8fafc' : '#0f172a' }}>VisualHealth</Link>
        <div style={{ display: 'flex', gap: 16 }}>
          <Link href="/analysis" className="vh-nav-link">{T('Analysis')}</Link>
          <Link href="/community" className="vh-nav-link">{T('Community')}</Link>
        </div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        {/* Lang toggle */}
        <button
          onClick={()=>setLang(l=> l==='en'?'zh':'en')}
          title={lang==='en'?'切换到中文':'Switch to English'}
          className="vh-btn vh-btn-outline vh-btn-compact"
        >
          {lang==='en' ? '中文' : 'EN'}
        </button>
        {/* Theme toggle */}
        <button
          onClick={()=>setTheme(t=> t==='dark'?'light':'dark')}
          title={isDark?'Switch to Light':'切换夜间模式'}
          className="vh-btn vh-btn-outline vh-btn-compact"
          style={{ fontSize:16 }}
        >
          {isDark ? '☀️' : '🌙'}
        </button>
        {!mounted ? (
          // Placeholder to avoid flicker pre-mount
          <div style={{ width:96, height:40 }} />
        ) : !token ? (
          <Link href="/auth" className="vh-btn vh-btn-outline vh-btn-compact" style={{ textDecoration:'none' }}>{T('Login')}</Link>
        ) : (
          <div ref={menuRef} style={{ position:'relative' }}>
            <button onClick={() => setOpen(v=>!v)} style={{ display:'flex', alignItems:'center', gap:8, background:'transparent', border:'none', cursor:'pointer' }}>
              {avatarId ? (
                <img src={`${MEDIA_BASE}/file/${avatarId}?v=${avatarId}`}
                     alt="avatar" width={32} height={32}
                     style={{ width:32, height:32, borderRadius:'9999px', objectFit:'cover', display:'block', border:`1px solid ${isDark?'#334155':'#e5e7eb'}` }} />
              ) : (
                <div style={{ width:32, height:32, borderRadius:'9999px', background:isDark?'#e2e8f0':'#111', color:isDark?'#0f172a':'#fff', display:'grid', placeItems:'center', fontSize:14 }}>{initials}</div>
              )}
            </button>
            {open && (
              <div style={{ position:'absolute', right:0, marginTop:8, background:isDark?'#0f172a':'#fff', color:isDark?'#e2e8f0':'#0f172a', border:'1px solid #e5e7eb', borderRadius:12, boxShadow:'0 8px 24px rgba(0,0,0,0.15)', minWidth:200, overflow:'hidden' }}>
                <div style={{ padding:'10px 12px', borderBottom:'1px solid #f1f5f9' }}>
                  <div style={{ fontWeight:600 }}>{user?.display_name || user?.email}</div>
                  <div style={{ color:'#64748b', fontSize:12 }}>{user?.email}</div>
                </div>
                <Link href="/analysis" style={{ display:'block', padding:'10px 12px', textDecoration:'none', color:isDark?'#e2e8f0':'#0f172a' }}>{T('MyAnalysis')}</Link>
                <Link href="/community/post" style={{ display:'block', padding:'10px 12px', textDecoration:'none', color:isDark?'#e2e8f0':'#0f172a' }}>{T('CreatePost')}</Link>
                <Link href="/settings" style={{ display:'block', padding:'10px 12px', textDecoration:'none', color:isDark?'#e2e8f0':'#0f172a' }}>{T('Profile')}</Link>
                <button onClick={logout} style={{ width:'100%', textAlign:'left', padding:'10px 12px', background:'transparent', border:'none', color:'#b91c1c', borderTop:'1px solid #f1f5f9', cursor:'pointer' }}>{T('Logout')}</button>
              </div>
            )}
          </div>
        )}
      </div>
      {/* Theme styles are in app/globals.css */}
    </nav>
  );
}
