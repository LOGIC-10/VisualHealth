"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';

const FEED_BASE = process.env.NEXT_PUBLIC_API_FEED || 'http://localhost:4005';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';

export default function CommunityPage() {
  const { t, lang } = useI18n();
  const [posts, setPosts] = useState([]);
  const [token, setToken] = useState(null);

  async function load() {
    const resp = await fetch(FEED_BASE + '/posts');
    setPosts(await resp.json());
  }

  useEffect(() => {
    setToken(localStorage.getItem('vh_token'));
    load();
  }, []);

  function parseMediaIds(m) {
    if (Array.isArray(m)) return m;
    if (typeof m === 'string') {
      const s = m.replace(/^\{|\}$/g, '');
      if (!s) return [];
      return s.split(',').map(x => x.trim());
    }
    return [];
  }

  // Note: interactions (post/like) are moved to detail/create pages

  const gridStyle = useMemo(() => ({ columns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }), []);

  function formatRelativeTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = Math.max(0, now - d);
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (days > 3) {
      // YYYY-MM-DD (to day)
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${da}`;
    }
    if (days >= 1) return lang === 'zh' ? `${days}天前` : `${days}d ago`;
    if (hours >= 1) return lang === 'zh' ? `${hours}小时前` : `${hours}h ago`;
    if (mins >= 1) return lang === 'zh' ? `${mins}分钟前` : `${mins}m ago`;
    return lang === 'zh' ? '刚刚' : 'just now';
  }

  return (
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('CommunityTitle')}</h1>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        {token ? (
          <a href="/community/post" style={{ textDecoration: 'none', padding: '10px 14px', borderRadius: 8, background: '#111', color: '#fff' }}>{t('NewPost')}</a>
        ) : (
          <a href="/auth" style={{ textDecoration: 'none', padding: '10px 14px', borderRadius: 8, border:'1px solid #e5e7eb', background: '#fff', color: '#111' }}>{t('LoginToPost')}</a>
        )}
      </div>

      <div style={{ display:'grid', gridTemplateColumns: gridStyle.columns, gap: gridStyle.gap }}>
        {posts.map((p) => {
          const mids = parseMediaIds(p.media_ids);
          const cover = (mids && mids.length) ? `${MEDIA_BASE}/file/${mids[0]}` : null;
          return (
            <a key={p.id} href={`/community/${p.id}`} style={{ textDecoration: 'none', color: 'inherit', display:'block' }}>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 16, overflow: 'hidden', background: '#fff', display:'flex', flexDirection:'column' }}>
                {/* Fixed-ratio media area (4:5 like Xiaohongshu) */}
                <div style={{ position:'relative', width:'100%', paddingTop: '125%', background:'#f1f5f9' }}>
                  {cover ? (
                    <img src={cover} alt="cover" loading="lazy" style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
                  ) : (
                    <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', color:'#64748b', fontSize:14, padding:12, textAlign:'center' }}>
                      {p.content ? p.content.slice(0, 60) : 'No image'}
                    </div>
                  )}
                  {mids && mids.length > 1 && (
                    <div style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(0,0,0,0.55)', color: '#fff', padding: '2px 6px', borderRadius: 8, fontSize: 12 }}>+{mids.length - 1}</div>
                  )}
                </div>
                {/* Content area with 2-line clamp */}
                <div style={{ padding: 12, display:'flex', flexDirection:'column', gap: 6 }}>
                  <div style={{ color: '#0f172a', display:'-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient:'vertical', overflow:'hidden', minHeight: 40 }}>
                    {p.content}
                  </div>
                  <div style={{ display: 'flex', alignItems:'center', gap: 12, color: '#64748b', fontSize: 13 }}>
                    <span>❤️ {p.likes}</span>
                    <span>💬 {p.comments}</span>
                    <span style={{ color:'#94a3b8', fontSize:12 }}>· {formatRelativeTime(p.created_at)}</span>
                    <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:8 }}>
                      <div title={p.author_name || p.author_email} style={{ width:20, height:20, borderRadius:'50%', background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:11 }}>
                        {(p.author_name || p.author_email || 'U').trim()[0]?.toUpperCase?.() || 'U'}
                      </div>
                      <div style={{ fontSize:12, color:'#64748b', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', maxWidth:'10em' }}>
                        {p.author_name || p.author_email || 'User'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function Cover({ src }){
  const [loaded,setLoaded]=useState(false);
  return (
    <div style={{ position:'relative' }}>
      {!loaded && <div style={{ position:'absolute', inset:0, background:'linear-gradient(90deg,#f1f5f9,#e2e8f0,#f1f5f9)', animation:'vh-shimmer 1.2s infinite' }} />}
      <img src={src} alt="cover" loading="lazy" onLoad={()=>setLoaded(true)} onError={()=>setLoaded(true)} style={{ width:'100%', height:'auto', display:'block', objectFit:'cover' }} />
      <style>{`@keyframes vh-shimmer{0%{background-position:-200px 0}100%{background-position:200px 0}}`}</style>
    </div>
  );
}
