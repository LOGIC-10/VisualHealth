"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';

const FEED_BASE = process.env.NEXT_PUBLIC_API_FEED || 'http://localhost:4005';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';

export default function CommunityPage() {
  const { t } = useI18n();
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

  const columnsStyle = useMemo(() => ({ columnWidth: '260px', columnGap: '12px' }), []);

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

      <div style={{ columnWidth: columnsStyle.columnWidth, columnGap: columnsStyle.columnGap }}>
        {posts.map((p) => {
          const mids = parseMediaIds(p.media_ids);
          const cover = (mids && mids.length) ? `${MEDIA_BASE}/file/${mids[0]}` : null;
          return (
            <a key={p.id} href={`/community/${p.id}`} style={{ textDecoration: 'none', color: 'inherit', breakInside:'avoid', display:'block', width:'100%', marginBottom:12 }}>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 16, overflow: 'hidden', background: '#fff' }}>
                <div style={{ position: 'relative', width: '100%', background: '#f1f5f9' }}>
                  {cover ? (
                    <Cover src={cover} />
                  ) : (
                    <div style={{ padding: 12, fontSize: 14, color: '#475569' }}>{p.content.slice(0, 120)}</div>
                  )}
                  {mids && mids.length > 1 && (
                    <div style={{ position: 'absolute', right: 8, bottom: 8, background: 'rgba(0,0,0,0.55)', color: '#fff', padding: '2px 6px', borderRadius: 8, fontSize: 12 }}>+{mids.length - 1}</div>
                  )}
                </div>
                <div style={{ padding: 12 }}>
                  <div style={{ color: '#0f172a', marginBottom: 6 }}>{p.content}</div>
                  <div style={{ display: 'flex', gap: 12, color: '#64748b', fontSize: 13 }}>
                    <span>❤️ {p.likes}</span>
                    <span>💬 {p.comments}</span>
                    <span>{new Date(p.created_at).toLocaleString()}</span>
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
