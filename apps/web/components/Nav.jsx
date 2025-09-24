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
  const [isCompact, setIsCompact] = useState(false);
  const [navLinksOpen, setNavLinksOpen] = useState(false);

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

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = () => setIsCompact(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else if (mq.addListener) mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else if (mq.removeListener) mq.removeListener(handler);
    };
  }, []);

  useEffect(() => { if (!isCompact) setNavLinksOpen(false); }, [isCompact]);

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

  const navStyle = {
    position: 'sticky',
    top: 0,
    zIndex: 10,
    background: isDark ? 'rgba(11,18,32,0.92)' : 'rgba(255,255,255,0.92)',
    borderBottom: `1px solid ${isDark ? '#283548' : '#e5e7eb'}`,
    boxShadow: isDark ? '0 1px 8px rgba(0,0,0,0.25)' : '0 1px 8px rgba(0,0,0,0.06)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: isCompact ? 'flex-start' : 'space-between',
    gap: isCompact ? 12 : 16,
    padding: isCompact ? '12px 16px' : '14px 24px',
    flexWrap: isCompact ? 'wrap' : 'nowrap'
  };

  const leftWrapStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: isCompact ? 12 : 18,
    flex: isCompact ? '1 1 100%' : '0 0 auto',
    justifyContent: isCompact ? 'space-between' : 'flex-start',
    width: isCompact ? '100%' : 'auto'
  };

  const actionsStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: isCompact ? 'wrap' : 'nowrap',
    justifyContent: isCompact ? 'flex-end' : 'flex-start',
    flex: isCompact ? '1 1 100%' : '0 0 auto'
  };

  const mobileLinksStyle = {
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    paddingTop: 8
  };

  return (
    <nav style={navStyle}>
      <div style={leftWrapStyle}>
        <Link href="/" style={{ fontWeight: 800, fontSize: 22, letterSpacing: '-0.02em', textDecoration: 'none', color: isDark ? '#f8fafc' : '#0f172a' }}>VisualHealth</Link>
        {isCompact ? (
          <button
            onClick={()=>setNavLinksOpen(v=>!v)}
            aria-label={navLinksOpen ? 'Close navigation' : 'Open navigation'}
            aria-expanded={navLinksOpen}
            style={{ border:'1px solid #e5e7eb', background:isDark?'#0f172a':'#fff', color:isDark?'#e2e8f0':'#0f172a', borderRadius:10, padding:'6px 10px', display:'inline-flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d={navLinksOpen ? 'M5 5l14 14M19 5L5 19' : 'M4 7h16M4 12h16M4 17h16'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
          </button>
        ) : (
          <div style={{ display: 'flex', gap: 16 }}>
            <Link href="/analysis" className="vh-nav-link">{T('Analysis')}</Link>
            <Link href="/community" className="vh-nav-link">{T('Community')}</Link>
          </div>
        )}
      </div>
      <div style={actionsStyle}>
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
      {isCompact && navLinksOpen && (
        <div style={mobileLinksStyle}>
          <Link href="/analysis" className="vh-nav-link" style={{ padding:'6px 0' }} onClick={()=>setNavLinksOpen(false)}>{T('Analysis')}</Link>
          <Link href="/community" className="vh-nav-link" style={{ padding:'6px 0' }} onClick={()=>setNavLinksOpen(false)}>{T('Community')}</Link>
          {!token && (
            <Link href="/auth" className="vh-nav-link" style={{ padding:'6px 0' }} onClick={()=>setNavLinksOpen(false)}>{T('Login')}</Link>
          )}
        </div>
      )}
      {/* Theme styles are in app/globals.css */}
    </nav>
  );
}
