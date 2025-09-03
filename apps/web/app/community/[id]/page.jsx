"use client";
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../../components/i18n';

const FEED_BASE = process.env.NEXT_PUBLIC_API_FEED || 'http://localhost:4005';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';

export default function PostDetail({ params }) {
  const { t } = useI18n();
  const { id } = params;
  const [post, setPost] = useState(null);
  const [comments, setComments] = useState([]);
  const [content, setContent] = useState('');
  const [files, setFiles] = useState([]);
  const [token, setToken] = useState(null);
  const scrollerRef = useRef(null);
  const fileInputRef = useRef(null);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const replaceInputRef = useRef(null);
  const [replaceIndex, setReplaceIndex] = useState(null);
  const [lightbox, setLightbox] = useState({ open: false, index: 0 });

  async function load() {
    const [p, c] = await Promise.all([
      fetch(FEED_BASE + `/posts/${id}`).then(r => r.json()),
      fetch(FEED_BASE + `/posts/${id}/comments`).then(r => r.json()),
    ]);
    setPost(p);
    setComments(c);
  }

  useEffect(() => {
    setToken(localStorage.getItem('vh_token'));
    load();
  }, [id]);

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
    load();
  }

  function scrollBy(delta) {
    const el = scrollerRef.current; if (!el) return;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  }

  if (!post) return <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>{t('Loading')}</div>;

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <a href="/community" style={{ textDecoration: 'none', color: '#2563eb' }}>← {t('Back')}</a>
      <h1 style={{ fontSize: 24, margin: '12px 0' }}>{post.content}</h1>
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
      <div style={{ marginTop: 8, color: '#64748b' }}>{new Date(post.created_at).toLocaleString()} • ❤️ {post.likes} • 💬 {post.comments}</div>

      <h3 style={{ marginTop: 24 }}>Comments</h3>
      <div style={{ display: 'grid', gap: 12 }}>
        {comments.map((c) => (
          <div key={c.id} style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
            <div style={{ fontSize: 12, color: '#64748b' }}>{new Date(c.created_at).toLocaleString()}</div>
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
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, borderTop: '1px solid #e5e7eb', paddingTop: 12 }}>
        <textarea placeholder="Write a comment..." value={content} onChange={e => setContent(e.target.value)} style={{ width: '100%', padding: 12, borderRadius: 8, border: '1px solid #e5e7eb' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
          <input ref={fileInputRef} style={{ display: 'none' }} type="file" multiple accept="image/*" onChange={onPick} />
          <span style={{ color: '#64748b' }}>{files.length} / 12</span>
          <button onClick={comment} style={{ padding: '8px 12px', borderRadius: 8, background: '#111', color: '#fff' }}>Send</button>
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
