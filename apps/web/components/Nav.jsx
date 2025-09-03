"use client";
import { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';

const AUTH_BASE = process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001';

export default function Nav() {
  const { t } = useI18n();
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState('light'); // 'light' | 'dark'
  const [lang, setLang] = useState('en'); // 'en' | 'zh'
  const menuRef = useRef(null);

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    setToken(t);
    if (!t) return;
    fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${t}` } })
      .then(r => r.json())
      .then(u => { if (!u.error) setUser(u); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function onDoc(e){ if (!menuRef.current) return; if (!menuRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  // init theme/lang from storage
  useEffect(() => {
    const th = localStorage.getItem('vh_theme');
    const lg = localStorage.getItem('vh_lang');
    if (th === 'dark' || th === 'light') setTheme(th);
    if (lg === 'zh' || lg === 'en') setLang(lg);
  }, []);

  // apply theme/lang to document
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.setAttribute('data-lang', lang);
    }
    try { localStorage.setItem('vh_theme', theme); } catch {}
    try { localStorage.setItem('vh_lang', lang); } catch {}
    try { window.dispatchEvent(new CustomEvent('vh_lang_change', { detail: lang })); } catch {}
  }, [theme, lang]);

  function logout(){
    localStorage.removeItem('vh_token');
    window.location.href = '/';
  }

  const initials = (user?.display_name || user?.email || 'U').trim()[0]?.toUpperCase?.() || 'U';
  const isDark = theme === 'dark';
  const T = t;

  return (
    <nav style={{ position: 'sticky', top: 0, zIndex: 10, backdropFilter: 'saturate(180%) blur(20px)', background: isDark ? 'rgba(15,23,42,0.6)' : 'rgba(255,255,255,0.6)', borderBottom: `1px solid ${isDark ? '#334155' : '#eee'}`, display: 'flex', alignItems:'center', justifyContent:'space-between', gap: 16, padding: '12px 24px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:16 }}>
        <a href="/" style={{ fontWeight: 700, textDecoration: 'none', color: isDark ? '#f8fafc' : '#111' }}>VisualHealth</a>
        <div style={{ display: 'flex', gap: 12 }}>
          <a href="/analysis" style={{ color: isDark ? '#e2e8f0' : undefined }}>{T('Analysis')}</a>
          <a href="/community" style={{ color: isDark ? '#e2e8f0' : undefined }}>{T('Community')}</a>
        </div>
      </div>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        {/* Lang toggle */}
        <button onClick={()=>setLang(l=> l==='en'?'zh':'en')} title={lang==='en'?'中文':'English'}
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:isDark?'#0f172a':'#fff', color:isDark?'#e2e8f0':'#111', cursor:'pointer' }}>
          {lang==='en' ? 'EN' : '中文'}
        </button>
        {/* Theme toggle */}
        <button onClick={()=>setTheme(t=> t==='dark'?'light':'dark')} title={isDark?'Switch to Light':'切换夜间模式'}
          style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:isDark?'#0f172a':'#fff', color:isDark?'#e2e8f0':'#111', cursor:'pointer' }}>
          {isDark ? '☀️' : '🌙'}
        </button>
        {!token && (
          <a href="/auth" style={{ textDecoration:'none', padding:'8px 12px', borderRadius:8, border:'1px solid #e5e7eb', background:isDark?'#0f172a':'#fff', color:isDark?'#e2e8f0':'#111' }}>{T('Login')}</a>
        )}
        {token && (
          <div ref={menuRef} style={{ position:'relative' }}>
            <button onClick={() => setOpen(v=>!v)} style={{ display:'flex', alignItems:'center', gap:8, background:'transparent', border:'none', cursor:'pointer' }}>
              <div style={{ width:32, height:32, borderRadius:'9999px', background:isDark?'#e2e8f0':'#111', color:isDark?'#0f172a':'#fff', display:'grid', placeItems:'center', fontSize:14 }}>{initials}</div>
            </button>
            {open && (
              <div style={{ position:'absolute', right:0, marginTop:8, background:isDark?'#0f172a':'#fff', color:isDark?'#e2e8f0':'#0f172a', border:'1px solid #e5e7eb', borderRadius:12, boxShadow:'0 4px 24px rgba(0,0,0,0.3)', minWidth:200, overflow:'hidden' }}>
                <div style={{ padding:'10px 12px', borderBottom:'1px solid #f1f5f9' }}>
                  <div style={{ fontWeight:600 }}>{user?.display_name || user?.email}</div>
                  <div style={{ color:'#64748b', fontSize:12 }}>{user?.email}</div>
                </div>
                <a href="/analysis" style={{ display:'block', padding:'10px 12px', textDecoration:'none', color:isDark?'#e2e8f0':'#0f172a' }}>{T('MyAnalysis')}</a>
                <a href="/community/post" style={{ display:'block', padding:'10px 12px', textDecoration:'none', color:isDark?'#e2e8f0':'#0f172a' }}>{T('CreatePost')}</a>
                <a href="/settings" style={{ display:'block', padding:'10px 12px', textDecoration:'none', color:isDark?'#e2e8f0':'#0f172a' }}>{T('Profile')}</a>
                <button onClick={logout} style={{ width:'100%', textAlign:'left', padding:'10px 12px', background:'transparent', border:'none', color:'#b91c1c', borderTop:'1px solid #f1f5f9', cursor:'pointer' }}>{T('Logout')}</button>
              </div>
            )}
          </div>
        )}
      </div>
      {/* Global theme basics */}
      <style>{`
        :root { color-scheme: light dark; }
        [data-theme='light'] body {
          color:#0f172a;
          background-color:#ffffff;
          background-image: url('/images/HeartHealthBackground_day.png');
          background-size: cover;
          background-position: center;
          background-attachment: fixed;
          background-repeat: no-repeat;
        }
        [data-theme='dark'] body {
          color:#e2e8f0;
          background-color:#0b1220;
          background-image: url('/images/HeartHealthBackground_night.png');
          background-size: cover;
          background-position: center;
          background-attachment: fixed;
          background-repeat: no-repeat;
        }
        a { color: inherit; }
      `}</style>
    </nav>
  );
}
