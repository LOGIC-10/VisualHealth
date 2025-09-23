"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../../components/i18n';
import { API } from '../../../lib/api';

const FEED_BASE = API.feed;
const MEDIA_BASE = API.media;
const AUTH_BASE = API.auth;

export default function PostDetail({ params }) {
  const { t, lang } = useI18n();
  const { id } = params;
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [content, setContent] = useState('');
  const [files, setFiles] = useState([]);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const scrollerRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const replaceInputRef = useRef(null);
  const [replaceIndex, setReplaceIndex] = useState(null);
  const [lightbox, setLightbox] = useState({ open: false, index: 0 });
  const [me, setMe] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [liking, setLiking] = useState(false);
  const [replyTarget, setReplyTarget] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [replyFiles, setReplyFiles] = useState([]);

  async function load(withToken, isCancelled) {
    setLoading(true);
    setLoadErr('');
    try {
      const headers = withToken ? { Authorization: `Bearer ${withToken}` } : undefined;
      const postResp = await fetch(FEED_BASE + `/posts/${id}`, { headers });
      if (postResp.status === 404) {
        if (!isCancelled?.()) {
          setPost(null);
          setComments([]);
          setLoadErr(lang === 'zh' ? '帖子不存在或已删除。' : 'This post is no longer available.');
        }
        return;
      }
      if (!postResp.ok) {
        const text = await postResp.text().catch(() => '');
        throw new Error(`post load failed: ${postResp.status} ${postResp.statusText} ${text}`.trim());
      }
      const postData = await postResp.json().catch(() => null);
      if (postData?.error) {
        throw new Error(typeof postData.error === 'string' ? postData.error : 'unable to load post');
      }

      let commentsData = [];
      try {
        const commentsResp = await fetch(FEED_BASE + `/posts/${id}/comments`, { headers });
        if (commentsResp.ok) {
          const parsed = await commentsResp.json().catch(() => []);
          commentsData = Array.isArray(parsed) ? parsed : [];
        } else if (commentsResp.status !== 404) {
          const txt = await commentsResp.text().catch(() => '');
          console.warn('community comments load non-ok', commentsResp.status, txt);
        }
      } catch (err) {
        console.warn('community comments load failed', err);
      }

      if (isCancelled?.()) return;
      setPost(postData || null);
      setComments(commentsData);
    } catch (err) {
      if (isCancelled?.()) return;
      console.warn('community post load failed', err);
      setPost(null);
      setComments([]);
      setLoadErr(lang === 'zh' ? '加载帖子内容失败，请稍后再试。' : 'Unable to load this post right now.');
    } finally {
      if (!isCancelled?.()) setLoading(false);
    }
  }

  useEffect(() => {
    let stored = null;
    try { stored = localStorage.getItem('vh_token'); } catch {}
    const normalized = stored || '';
    setToken(normalized);
    if (normalized) {
      fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${normalized}` } })
        .then(r => r.ok ? r.json() : Promise.reject(r))
        .then(u => { if (u && !u.error) setMe(u); })
        .catch(() => {});
    } else {
      setMe(null);
    }
  }, [id]);

  // Update UI authors immediately when profile changes (without refetch)
  useEffect(() => {
    function onUserChange(ev){
      const u = ev?.detail; if (!u || !u.id) return;
      setPost(p => p && p.user_id===u.id ? { ...p, author_display_name: u.display_name || u.email || p.author_display_name || p.author_name || p.author_email, author_avatar_media_id: u.avatar_media_id || null, author_email: u.email || p.author_email } : p);
      setComments(cs => cs.map(c => c.user_id===u.id ? { ...c, author_display_name: u.display_name || u.email || c.author_display_name || c.author_name || c.author_email, author_avatar_media_id: u.avatar_media_id || null, author_email: u.email || c.author_email } : c));
    }
    window.addEventListener('vh_user_change', onUserChange);
    return () => window.removeEventListener('vh_user_change', onUserChange);
  }, []);

  useEffect(() => {
    // Load post when token state resolved
    if (token === null) return;
    let cancelled = false;
    load(token || undefined, () => cancelled);
    return () => { cancelled = true; };
  }, [id, token, lang]);

  function onPick(e) {
    const selected = Array.from(e.target.files || []);
    const capacity = Math.max(0, 12 - files.length);
    const next = selected.slice(0, capacity);
    setFiles(prev => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
  function openPicker() { fileInputRef.current?.click(); }
  function openReplace(i){ setReplaceIndex(i); replaceInputRef.current?.click(); }
  function onReplace(e){ const f=(e.target.files||[])[0]; if(!f&&f!==0) return; setFiles(prev=>prev.map((x,idx)=>idx===replaceIndex?f:x)); if(replaceInputRef.current) replaceInputRef.current.value=''; setReplaceIndex(null); }
  function reorder(arr, from, to) { const copy = arr.slice(); const [it] = copy.splice(from,1); copy.splice(to,0,it); return copy; }
  function onDragStart(i,e){ setDragIndex(i); e.dataTransfer.effectAllowed='move'; e.dataTransfer.setData('text/plain', String(i)); }
  function onDragOver(i,e){ e.preventDefault(); setOverIndex(i); }
  function onDrop(i,e){ e.preventDefault(); const from = dragIndex!=null?dragIndex:parseInt(e.dataTransfer.getData('text/plain')||'-1',10); if(from>=0&&i>=0&&from!==i) setFiles(prev=>reorder(prev,from,i)); setDragIndex(null); setOverIndex(null); }
  function onDragEnd(){ setDragIndex(null); setOverIndex(null); }

  async function uploadImagesPublic(arr) {
    const ids = [];
    for (const f of arr) {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('public', 'true');
      const r = await fetch(MEDIA_BASE + '/upload', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
      const j = await r.json();
      if (!j.id) throw new Error('upload failed');
      ids.push(j.id);
    }
    return ids;
  }

  async function comment() {
    if (!token) return alert('Please login');
    if (!content && files.length === 0) return alert('Add text or images');
    const mediaIds = files.length ? await uploadImagesPublic(files) : [];
    await fetch(FEED_BASE + `/posts/${id}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content, mediaIds })
    });
    setContent(''); setFiles([]);
    load(token);
  }

  async function sendReply(parentId){
    if (!token) return alert('Please login');
    const text = replyText.trim(); if (!text && replyFiles.length===0) return;
    setReplying(true);
    try {
      const mediaIds = replyFiles.length ? await uploadImagesPublic(replyFiles) : [];
      await fetch(FEED_BASE + `/posts/${id}/comments`, {
        method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ content: text, parentId, mediaIds })
      });
      setReplyText(''); setReplyTarget(null); setReplyFiles([]);
      load(token);
    } finally { setReplying(false); }
  }

  function scrollBy(delta) {
    const el = scrollerRef.current; if (!el) return;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  }

  async function toggleLike(){
    if (!token || !post) return;
    if (liking) return;
    setLiking(true);
    try {
      if (post.liked_by_me) {
        await fetch(FEED_BASE + `/posts/${id}/like`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` } });
        setPost(p => ({ ...p, liked_by_me:false, likes: Math.max(0, (p.likes||0)-1) }));
      } else {
        await fetch(FEED_BASE + `/posts/${id}/like`, { method:'POST', headers:{ Authorization:`Bearer ${token}` } });
        setPost(p => ({ ...p, liked_by_me:true, likes: (p.likes||0)+1 }));
      }
    } finally { setLiking(false); }
  }

  async function saveEdit(){
    if (!token || !post) return;
    const r = await fetch(FEED_BASE + `/posts/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ content: editText }) });
    if (r.ok) { const j = await r.json(); setPost(p=>({ ...p, content: j.content })); setEditing(false); }
  }
  async function deletePost(){
    if (!token || !post) return;
    const ok = window.confirm('确认删除该帖子？此操作不可撤销。');
    if (!ok) return;
    const r = await fetch(FEED_BASE + `/posts/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` } });
    if (r.status === 204) window.location.href = '/community';
  }

  if (loading) {
    return <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>{t('Loading')}</div>;
  }
  if (loadErr) {
    return (
      <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
        <Link href="/community" style={{ textDecoration: 'none', color: '#2563eb', display:'inline-block', marginBottom:12 }}>{t('Back')}</Link>
        <div style={{ padding:16, borderRadius:12, border:'1px solid #fecaca', background:'#fef2f2', color:'#b91c1c' }}>{loadErr}</div>
      </div>
    );
  }
  if (!post) {
    return (
      <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
        <Link href="/community" style={{ textDecoration: 'none', color: '#2563eb', display:'inline-block', marginBottom:12 }}>{t('Back')}</Link>
        <div style={{ color:'#94a3b8' }}>{lang === 'zh' ? '帖子不存在或已删除。' : 'This post could not be found.'}</div>
      </div>
    );
  }

  // Build nested comment tree
  function buildTree(list){
    const map = new Map(); const roots = [];
    for (const c of list) map.set(c.id, { ...c, children: [] });
    for (const c of map.values()){
      if (c.parent_id && map.has(c.parent_id)) map.get(c.parent_id).children.push(c); else roots.push(c);
    }
    return { roots, map };
  }
  const { roots: tree, map: commentMap } = buildTree(comments || []);

  function formatRelativeTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diff = Math.max(0, now - d);
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (days > 3) {
      const y = d.getFullYear(); const m = String(d.getMonth()+1).padStart(2,'0'); const da = String(d.getDate()).padStart(2,'0');
      return `${y}-${m}-${da}`;
    }
    if (days >= 1) return lang === 'zh' ? `${days}天前` : `${days}d ago`;
    if (hours >= 1) return lang === 'zh' ? `${hours}小时前` : `${hours}h ago`;
    if (mins >= 1) return lang === 'zh' ? `${mins}分钟前` : `${mins}m ago`;
    return lang === 'zh' ? '刚刚' : 'just now';
  }

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <Link href="/community" style={{ textDecoration: 'none', color: '#2563eb' }}>{t('Back')}</Link>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
        {!editing && <h1 style={{ fontSize: 24, margin: '12px 0' }}>{post.content}</h1>}
        {editing && (
          <div style={{ flex:1, display:'flex', gap:8, alignItems:'center' }}>
            <input value={editText} onChange={e=>setEditText(e.target.value)} style={{ flex:1, padding:8, border:'1px solid #e5e7eb', borderRadius:8 }} />
            <button onClick={()=>setEditing(false)} style={{ padding:'8px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>取消</button>
          <button onClick={saveEdit} className="vh-btn vh-btn-primary" style={{ padding:'8px 10px' }}>保存</button>
          </div>
        )}
        {/* Owner actions menu */}
        {me?.id && post.user_id === me.id && (
          <div style={{ position:'relative' }}>
            <button onClick={()=>{ setMenuOpen(v=>!v); setEditText(post.content||''); }} title="更多" style={{ background:'transparent', border:'none', cursor:'pointer', padding:6, borderRadius:8 }}>⋯</button>
            {menuOpen && (
              <div onMouseLeave={()=>setMenuOpen(false)} style={{ position:'absolute', right:0, top:'100%', marginTop:6, background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, boxShadow:'0 8px 24px rgba(0,0,0,0.08)', minWidth:140, overflow:'hidden', zIndex:5 }}>
                <button onClick={()=>{ setEditing(true); setMenuOpen(false); }} style={{ display:'block', width:'100%', textAlign:'left', padding:'8px 10px', background:'transparent', border:'none', cursor:'pointer' }}>编辑</button>
                <button onClick={()=>{ setMenuOpen(false); deletePost(); }} style={{ display:'block', width:'100%', textAlign:'left', padding:'8px 10px', background:'transparent', border:'none', color:'#b91c1c', cursor:'pointer' }}>删除</button>
              </div>
            )}
          </div>
        )}
      </div>
      {post.media_ids?.length > 0 && (
        <div style={{ position: 'relative' }}>
          <div ref={scrollerRef} style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: '100%', overflowX: 'auto', scrollSnapType: 'x mandatory', gap: 8, borderRadius: 12 }}>
            {post.media_ids.map((mid, idx) => (
              <div key={mid} style={{ scrollSnapAlign: 'center', position: 'relative', width:'100%', aspectRatio: '1 / 1', background: '#f1f5f9' }}>
                <img src={`${MEDIA_BASE}/file/${mid}`} alt="image" loading="lazy" onClick={()=>setLightbox({open:true, index: idx})} style={{ width: '100%', height: '100%', objectFit: 'cover', cursor:'zoom-in' }} />
              </div>
            ))}
          </div>
          <div style={{ position: 'absolute', top: '50%', left: 8, transform: 'translateY(-50%)', display: 'flex', gap: 8 }}>
            <button onClick={() => scrollBy(-400)} style={{ padding: 8, borderRadius: '9999px', border: '1px solid #e5e7eb', background: 'rgba(255,255,255,0.8)' }}>‹</button>
          </div>
          <div style={{ position: 'absolute', top: '50%', right: 8, transform: 'translateY(-50%)', display: 'flex', gap: 8 }}>
            <button onClick={() => scrollBy(400)} style={{ padding: 8, borderRadius: '9999px', border: '1px solid #e5e7eb', background: 'rgba(255,255,255,0.8)' }}>›</button>
          </div>
        </div>
      )}
      <div style={{ marginTop: 8, color: '#64748b', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        <div style={{ display:'inline-flex', alignItems:'center', gap:8 }}>
          {post.author_avatar_media_id ? (
            <img src={`${MEDIA_BASE}/file/${post.author_avatar_media_id}?v=${post.author_avatar_media_id}`} alt="author" width={20} height={20} style={{ width:20, height:20, borderRadius:'50%', objectFit:'cover', display:'block' }} />
          ) : (
            <div title={post.author_display_name || post.author_name || post.author_email} style={{ width:20, height:20, borderRadius:'50%', background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:11 }}>
              {(post.author_display_name || post.author_name || post.author_email || 'U').trim()[0]?.toUpperCase?.() || 'U'}
            </div>
          )}
          <div style={{ fontSize:12, color:'#64748b' }}>{post.author_display_name || post.author_name || post.author_email || 'User'}</div>
        </div>
        <span style={{ color:'#94a3b8', fontSize:12 }}>· {formatRelativeTime(post.created_at)}</span>
        <button onClick={toggleLike} disabled={!token} title={post.liked_by_me ? '取消点赞' : '点赞'} style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'4px 8px', borderRadius:9999, border:'1px solid #e5e7eb', background: post.liked_by_me ? '#fee2e2' : '#fff', color:'#b91c1c', cursor: token ? 'pointer':'not-allowed' }}>
          <span>{post.liked_by_me ? '❤️' : '♡'}</span>
          <span style={{ color:'#475569' }}>{post.likes || 0}</span>
        </button>
        <span>💬 {post.comments}</span>
      </div>

      <h3 style={{ marginTop: 24 }}>Comments</h3>
      <div style={{ display:'grid', gap: 12 }}>
        {tree.map((c) => (
          <CommentItem key={c.id} c={c} depth={0} onReply={(id)=>{ setReplyTarget(id); setReplyText(''); setReplyFiles([]); }}
            replyingId={replyTarget} replyText={replyText} setReplyText={setReplyText} onSendReply={sendReply} token={token} replyFiles={replyFiles} setReplyFiles={setReplyFiles} formatRelativeTime={formatRelativeTime} commentMap={commentMap} lang={lang} />
        ))}
      </div>

      <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
        <textarea placeholder="Write a comment..." value={content} onChange={e => setContent(e.target.value)} style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <input ref={fileInputRef} style={{ display: 'none' }} type="file" multiple accept="image/*" onChange={onPick} />
          <span style={{ color: '#64748b' }}>{files.length} / 12</span>
          <button onClick={comment} className="vh-btn vh-btn-primary">Send</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginTop: 8 }}>
          {files.map((f, i) => (
            <div key={i}
              draggable
              onDragStart={(e)=>onDragStart(i,e)}
              onDragOver={(e)=>onDragOver(i,e)}
              onDrop={(e)=>onDrop(i,e)}
              onDragEnd={onDragEnd}
              style={{ borderRadius: 8, overflow: 'hidden', background: '#f1f5f9', aspectRatio: '1 / 1', outline: overIndex===i?'2px solid #2563eb':'none', opacity: dragIndex===i?0.7:1 }}>
              <img src={URL.createObjectURL(f)} alt="preview" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <div style={{ position:'absolute', top:6, right:6, display:'flex', gap:6 }}>
                <button onClick={()=>setFiles(prev=>prev.filter((_,idx)=>idx!==i))} style={{ background:'rgba(0,0,0,0.55)', color:'#fff', border:'none', borderRadius:8, padding:'4px 8px', cursor:'pointer' }}>×</button>
                <button onClick={()=>openReplace(i)} style={{ background:'rgba(0,0,0,0.55)', color:'#fff', border:'none', borderRadius:8, padding:'4px 8px', cursor:'pointer' }}>Replace</button>
              </div>
            </div>
          ))}
          {files.length < 12 && (
            <button onClick={openPicker}
              onDragOver={(e)=>onDragOver(files.length,e)}
              onDrop={(e)=>onDrop(files.length,e)}
              style={{ cursor:'pointer', border:'2px dashed #94a3b8', borderRadius:8, aspectRatio:'1 / 1', background:'#f8fafc', color:'#64748b', display:'grid', placeItems:'center', fontSize:36 }}>+
            </button>
          )}
        </div>
        <input ref={replaceInputRef} style={{ display:'none' }} type="file" accept="image/*" onChange={onReplace} />
      </div>

      {/* Lightbox */}
      {lightbox.open && (
        <Lightbox images={post.media_ids} index={lightbox.index} onClose={()=>setLightbox({open:false,index:0})} />
      )}
    </div>
  );
}

function Lightbox({ images, index=0, onClose }){
  const [i,setI]=useState(index);
  const [zoom,setZoom]=useState(1);
  const [drag,setDrag]=useState(null);
  function prev(){ setI(v=> (v-1+images.length)%images.length); setZoom(1); }
  function next(){ setI(v=> (v+1)%images.length); setZoom(1); }
  function wheel(e){ e.preventDefault(); setZoom(z=> Math.max(1, Math.min(4, z + (e.deltaY<0?0.2:-0.2)))); }
  return (
    <div onClick={onClose} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.9)', zIndex:1000, display:'grid', placeItems:'center' }}>
      <div onClick={e=>e.stopPropagation()} style={{ position:'relative', width:'90vw', height:'90vh', display:'grid', placeItems:'center' }} onWheel={wheel}>
        <img src={`${MEDIA_BASE}/file/${images[i]}`} alt="" style={{ maxWidth:'100%', maxHeight:'100%', transform:`scale(${zoom})`, transition:'transform 120ms ease', userSelect:'none' }} />
        <div style={{ position:'absolute', top:16, right:16, display:'flex', gap:8 }}>
          <button onClick={()=>setZoom(z=>Math.min(4,z+0.2))} style={{ background:'#fff', border:'none', borderRadius:8, padding:'6px 10px' }}>＋</button>
          <button onClick={()=>setZoom(z=>Math.max(1,z-0.2))} style={{ background:'#fff', border:'none', borderRadius:8, padding:'6px 10px' }}>－</button>
          <button onClick={onClose} style={{ background:'#fff', border:'none', borderRadius:8, padding:'6px 10px' }}>✕</button>
        </div>
        <div style={{ position:'absolute', left:16, top:'50%', transform:'translateY(-50%)' }}><button onClick={prev} style={{ background:'rgba(255,255,255,0.8)', border:'1px solid #e5e7eb', borderRadius:'9999px', padding:10 }}>‹</button></div>
        <div style={{ position:'absolute', right:16, top:'50%', transform:'translateY(-50%)' }}><button onClick={next} style={{ background:'rgba(255,255,255,0.8)', border:'1px solid #e5e7eb', borderRadius:'9999px', padding:10 }}>›</button></div>
        <div style={{ position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)', display:'flex', gap:6 }}>
          {images.map((_,idx)=> <span key={idx} style={{ width:8, height:8, borderRadius:'50%', background: idx===i?'#fff':'#64748b', display:'inline-block' }}/>)}
        </div>
      </div>
    </div>
  );
}

function CommentItem({ c, depth=0, onReply, replyingId, replyText, setReplyText, onSendReply, token, replyFiles, setReplyFiles, formatRelativeTime, commentMap, lang }){
  const MEDIA_BASE = API.media;
  const FEED_BASE = API.feed;
  const [visible, setVisible] = useState(0);
  const displayName = (cc) => (cc.author_display_name || cc.author_name || cc.author_email || 'User');
  const targetName = (cc) => {
    const p = cc.parent_id ? commentMap?.get?.(cc.parent_id) : null;
    return p ? displayName(p) : null;
  };
  const [myVote, setMyVote] = useState(c.my_vote || 0);
  const [up, setUp] = useState(c.up || 0);
  const [down, setDown] = useState(c.down || 0);
  async function vote(v){
    if (!token) return;
    try {
      if (myVote === v) {
        await fetch(FEED_BASE + `/comments/${c.id}/vote`, { method:'DELETE', headers:{ Authorization:`Bearer ${token}` } });
        if (v === 1) setUp(x=>Math.max(0,x-1)); else setDown(x=>Math.max(0,x-1));
        setMyVote(0);
      } else {
        const r = await fetch(FEED_BASE + `/comments/${c.id}/vote`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ value: v }) });
        if (r.ok) {
          if (v === 1) { setUp(x=>myVote===1?x:x+1); if (myVote===-1) setDown(x=>Math.max(0,x-1)); }
          if (v === -1) { setDown(x=>myVote===-1?x:x+1); if (myVote===1) setUp(x=>Math.max(0,x-1)); }
          setMyVote(v);
        }
      }
    } catch {}
  }

  function pickReplyFiles(e){ const arr = Array.from(e.target.files||[]).slice(0, 9); setReplyFiles(arr); e.target.value=''; }
  // constant indent for all replies (depth>=1)
  // Only top-level has no indent; all replies share a single indent applied on the children container
  const indentPx = 0;
  return (
    <div style={{ border: depth===0 ? '1px solid #e5e7eb' : 'none', borderRadius: depth===0 ? 12 : 0, padding:12, marginLeft: indentPx }}>
      <div style={{ display:'flex', alignItems:'center', gap:8 }}>
        {c.author_avatar_media_id ? (
          <img src={`${MEDIA_BASE}/file/${c.author_avatar_media_id}?v=${c.author_avatar_media_id}`} alt="author" width={28} height={28} style={{ width:28, height:28, borderRadius:'9999px', objectFit:'cover', display:'block' }} />
        ) : (
          <div title={c.author_display_name || c.author_name || c.author_email} style={{ width:28, height:28, borderRadius:'9999px', background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:12 }}>
            {(c.author_display_name || c.author_name || c.author_email || 'U').trim()[0]?.toUpperCase?.() || 'U'}
          </div>
        )}
        {depth>0 && <span style={{ color:'#94a3b8' }}>↪︎</span>}
        <div style={{ fontWeight:600, color:'#0f172a' }}>{displayName(c)}</div>
        {depth>0 && targetName(c) && (
          <>
            <span style={{ color:'#64748b', fontSize:12 }}>{lang==='zh'?'回复':'replied to'}</span>
            <div style={{ fontWeight:600, color:'#0f172a' }}>{targetName(c)}</div>
          </>
        )}
      </div>
      <div style={{ marginTop: 8 }}>{c.content}</div>
      {c.media_ids?.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8, marginTop: 8 }}>
          {c.media_ids.map((mid) => (
            <div key={mid} style={{ borderRadius: 8, overflow: 'hidden', background: '#f1f5f9', aspectRatio: '1 / 1' }}>
              <img src={`${MEDIA_BASE}/file/${mid}`} alt="comment image" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          ))}
        </div>
      )}
      {/* footer: time · thumbs up/down · reply */}
      <div style={{ marginTop: 8, display:'flex', alignItems:'center', gap:12, color:'#64748b', fontSize:13 }}>
        <span>{formatRelativeTime(c.created_at)}</span>
        <button onClick={()=>vote(1)} title={myVote===1?(lang==='zh'?'取消赞':'Unvote'):(lang==='zh'?'点赞':'Thumb up')} style={{ display:'inline-flex', alignItems:'center', gap:6, background:'transparent', border:'none', color: myVote===1? '#2563eb':'#475569', cursor: token?'pointer':'not-allowed' }}>👍 {up}</button>
        <button onClick={()=>vote(-1)} title={myVote===-1?(lang==='zh'?'取消踩':'Unvote'):(lang==='zh'?'点踩':'Thumb down')} style={{ display:'inline-flex', alignItems:'center', gap:6, background:'transparent', border:'none', color: myVote===-1? '#dc2626':'#475569', cursor: token?'pointer':'not-allowed' }}>👎 {down}</button>
        <button onClick={()=>onReply(c.id)} disabled={!token} style={{ background:'transparent', border:'none', color:'#2563eb', cursor: token?'pointer':'not-allowed' }}>{lang==='zh'?'回复':'Reply'}</button>
      </div>
      {replyingId === c.id && (
        <div style={{ marginTop: 8 }}>
          <input value={replyText} onChange={e=>setReplyText(e.target.value)} placeholder="写下你的回复…（可选）" style={{ width:'100%', padding:'6px 2px', border:'none', borderBottom:'1px solid #e5e7eb', outline:'none' }} />
          {/* reply images */}
          <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
            <input id={`reply-pick-${c.id}`} type="file" multiple accept="image/*" style={{ display:'none' }} onChange={pickReplyFiles} />
            <label htmlFor={`reply-pick-${c.id}`} style={{ cursor:'pointer', color:'#2563eb', fontSize:13 }}>添加图片</label>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
              {replyFiles.map((f,i)=> (
                <div key={i} style={{ width:48, height:48, borderRadius:6, overflow:'hidden', position:'relative', background:'#f1f5f9' }}>
                  <img src={URL.createObjectURL(f)} alt="preview" style={{ width:'100%', height:'100%', objectFit:'cover' }} />
                </div>
              ))}
            </div>
            <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
              <button onClick={()=>onSendReply(c.id)} disabled={false} className="vh-btn vh-btn-primary" style={{ padding:'6px 10px' }}>发送</button>
            </div>
          </div>
        </div>
      )}
      {Array.isArray(c.children) && c.children.length > 0 && (
        <div style={{ marginTop: 8, display:'grid', gap:8, marginLeft: depth===0 ? 28 : 0 }}>
          {visible === 0 && (
            <button onClick={()=>setVisible(c.children.length)} style={{ background:'transparent', border:'none', color:'#2563eb', textAlign:'left', padding:0, cursor:'pointer' }}>
              {lang==='zh'? `查看 ${c.children.length} 条回复` : `View ${c.children.length} replies`}
            </button>
          )}
          {visible > 0 && (
            <>
              {c.children.map(ch => (
                <CommentItem key={ch.id} c={ch} depth={depth+1} onReply={onReply} replyingId={replyingId} replyText={replyText} setReplyText={setReplyText} onSendReply={onSendReply} token={token} replyFiles={replyFiles} setReplyFiles={setReplyFiles} formatRelativeTime={formatRelativeTime} commentMap={commentMap} lang={lang} />
              ))}
              <button onClick={()=>setVisible(0)} style={{ background:'transparent', border:'none', color:'#2563eb', textAlign:'left', padding:0, cursor:'pointer' }}>{lang==='zh'?'收起':'Hide replies'}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
