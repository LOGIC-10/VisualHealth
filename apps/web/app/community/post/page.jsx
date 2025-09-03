"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../components/i18n';

const FEED_BASE = process.env.NEXT_PUBLIC_API_FEED || 'http://localhost:4005';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';

export default function CreatePostPage() {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [files, setFiles] = useState([]);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const fileInputRef = useRef(null);
  const replaceInputRef = useRef(null);
  const [replaceIndex, setReplaceIndex] = useState(null);

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    setToken(t);
    if (!t) {
      window.location.href = '/auth';
    }
  }, []);

  function onPick(e) {
    const selected = Array.from(e.target.files || []);
    if (!selected.length) return;
    const capacity = Math.max(0, 12 - files.length);
    const next = selected.slice(0, capacity);
    setFiles(prev => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
  function openPicker() { fileInputRef.current?.click(); }
  function openReplace(i){ setReplaceIndex(i); replaceInputRef.current?.click(); }
  function onReplace(e){
    const f = (e.target.files || [])[0];
    if (!f && f !== 0) return;
    setFiles(prev => prev.map((x, idx) => idx === replaceIndex ? f : x));
    if (replaceInputRef.current) replaceInputRef.current.value = '';
    setReplaceIndex(null);
  }
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

  async function publish() {
    if (!token) return alert('Please login');
    if (!content && files.length === 0) return alert('Add text or images');
    setBusy(true);
    try {
      const mediaIds = files.length ? await uploadImagesPublic(files) : [];
      const resp = await fetch(FEED_BASE + '/posts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content, mediaIds })
      });
      const json = await resp.json();
      if (json.id) window.location.href = `/community/${json.id}`; else window.location.href = '/community';
    } finally { setBusy(false); }
  }

  const gridCols = useMemo(() => ({ columns: 'repeat(auto-fill, minmax(220px, 1fr))' }), []);

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <a href="/community" style={{ textDecoration: 'none', color: '#2563eb' }}>← {t('Back')}</a>
      <h1 style={{ fontSize: 24, margin: '12px 0' }}>{t('CreatePostTitle')}</h1>
      <div style={{ display: 'grid', gap: 12 }}>
        <textarea placeholder={t('ShareStory')} value={content} onChange={e => setContent(e.target.value)} style={{ padding: 12, borderRadius: 8, border: '1px solid #e5e7eb', minHeight: 120 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input ref={fileInputRef} style={{ display: 'none' }} type="file" multiple accept="image/*" onChange={onPick} />
          <input ref={replaceInputRef} style={{ display: 'none' }} type="file" accept="image/*" onChange={onReplace} />
          <span style={{ color: '#64748b' }}>{files.length} / 12</span>
          <button onClick={openPicker} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff' }}>{t('AddImages')}</button>
          <button disabled={busy} onClick={publish} style={{ padding: '8px 12px', borderRadius: 8, background: '#111', color: '#fff' }}>{busy ? 'Posting...' : t('Post')}</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: gridCols.columns, gap: 8 }}>
          {files.map((f, i) => (
            <div key={i}
              draggable
              onDragStart={(e)=>onDragStart(i,e)}
              onDragOver={(e)=>onDragOver(i,e)}
              onDrop={(e)=>onDrop(i,e)}
              onDragEnd={onDragEnd}
              style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: '#f1f5f9', aspectRatio: '1 / 1', outline: overIndex===i? '2px solid #2563eb':'none', opacity: dragIndex===i?0.7:1 }}>
              <img src={URL.createObjectURL(f)} alt="preview" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display:'block' }} />
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
              style={{ cursor:'pointer', border:'2px dashed #94a3b8', borderRadius:12, aspectRatio:'1 / 1', background:'#f8fafc', color:'#64748b', display:'grid', placeItems:'center', fontSize:48 }}>
              +
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
