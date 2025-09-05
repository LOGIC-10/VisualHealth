"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';

const ANALYSIS_BASE = process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';
const VIZ_BASE = process.env.NEXT_PUBLIC_API_VIZ || 'http://localhost:4006';

export default function AnalysisListPage() {
  const { t } = useI18n();
  // Avoid SSR/CSR mismatch: init as null and set after mount
  const [token, setToken] = useState(null);
  useEffect(() => {
    try { setToken(localStorage.getItem('vh_token')); } catch { setToken(''); }
  }, []);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ total: 0, done: 0 });
  const fileInputRef = useRef(null);
  const [healing, setHealing] = useState({ running: false, total: 0, done: 0 });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterName, setFilterName] = useState('');
  const [filterType, setFilterType] = useState('');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [sortOrder, setSortOrder] = useState('desc'); // 'desc' or 'asc'

  useEffect(() => {
    if (token === null) { setLoading(false); return; }
    if (!token) { setLoading(false); return; }
    (async () => {
      try {
        const r = await fetch(ANALYSIS_BASE + '/records', { headers: { Authorization: `Bearer ${token}` } });
        const list = await r.json();
        setFiles(Array.isArray(list) ? list : []);
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  // Safety net: if healing runs too long (e.g., browser decode blocked), auto-hide after 30s
  useEffect(() => {
    if (!healing.running) return;
    const timer = setTimeout(() => {
      setHealing(h => ({ ...h, running: false }));
    }, 30000);
    return () => clearTimeout(timer);
  }, [healing.running]);

  // Background: precompute missing advanced/spectrogram for older records
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        // Use a fresh snapshot to avoid effect loops tied to `files`
        const r0 = await fetch(ANALYSIS_BASE + '/records', { headers: { Authorization: `Bearer ${token}` } });
        const list0 = await r0.json();
        const pending = (Array.isArray(list0) ? list0 : []).filter(f => !f.has_adv || !f.has_spec).slice(0, 5);
        if (pending.length === 0) return;
        setHealing({ running: true, total: pending.length, done: 0 });

        const decodeDownsample = async (arrayBuffer) => {
          const timeoutMs = 8000;
          const CtxA = window.OfflineAudioContext || window.webkitOfflineAudioContext || window.AudioContext || window.webkitAudioContext;
          if (!CtxA) return null;
          const task = (async () => {
            let audioCtx;
            try {
              // Prefer OfflineAudioContext to avoid autoplay/user-gesture policies
              if (window.OfflineAudioContext || window.webkitOfflineAudioContext) {
                const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
                audioCtx = new OC(1, 2, 44100);
              } else {
                const AC = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AC();
              }
              const buf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
              const ch = buf.getChannelData(0);
              const targetSR = 8000; const ratio = Math.max(1, Math.floor(buf.sampleRate / targetSR));
              const ds = new Float32Array(Math.ceil(ch.length / ratio));
              for (let i = 0; i < ds.length; i++) ds[i] = ch[i * ratio] || 0;
              try { await audioCtx.close?.(); } catch {}
              return { payload: { sampleRate: Math.round(buf.sampleRate / ratio), pcm: Array.from(ds) } };
            } catch {
              try { await audioCtx?.close?.(); } catch {}
              return null;
            }
          })();
          const timed = new Promise(resolve => setTimeout(() => resolve(null), timeoutMs));
          return await Promise.race([task, timed]);
        };

        const maxConcurrent = 1; // keep light to reduce decode pressure
        const running = new Set(); let idx = 0;
        const worker = async (item) => {
          try {
        // Prefer signed URL to fetch the audio without Authorization header
        let arr = null;
        try {
          const surl = await fetch(MEDIA_BASE + `/file_url/${item.media_id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (surl.ok) {
            const j = await surl.json();
            if (j?.url) {
              const fr = await fetch(j.url);
              if (fr.ok) {
                const blob = await fr.blob();
                arr = await blob.arrayBuffer();
              }
            }
          }
        } catch {}
        if (!arr) {
          const r = await fetch(MEDIA_BASE + `/file/${item.media_id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) return;
          const blob = await r.blob(); arr = await blob.arrayBuffer();
        }
        const dec = await decodeDownsample(arr); if (!dec) return;
            const { payload } = dec;
            const [advResp, specResp] = await Promise.all([
              item.has_adv ? Promise.resolve({ ok: false }) : fetch(VIZ_BASE + '/pcg_advanced', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) }),
              item.has_spec ? Promise.resolve({ ok: false }) : fetch(VIZ_BASE + '/spectrogram_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ...payload, maxFreq:2000, width:1200, height:320 }) })
            ]);
            let adv = null; let specId = null;
            if (advResp && advResp.ok) { try { adv = await advResp.json(); } catch {} }
            if (specResp && specResp.ok) {
              try {
                const imgBlob = await specResp.blob(); const fdu = new FormData();
                fdu.append('file', new File([imgBlob], 'spectrogram.png', { type:'image/png' }));
                const up = await fetch(MEDIA_BASE + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fdu });
                const j = await up.json(); if (j?.id) specId = j.id;
              } catch {}
            }
            if (!cancelled && (adv || specId)) {
              await fetch(ANALYSIS_BASE + `/records/${item.id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ adv: adv || undefined, specMediaId: specId || undefined }) });
            }
          } catch {}
          finally {
            if (!cancelled) setHealing(h => ({ ...h, done: Math.min(h.total, h.done + 1) }));
          }
        };

        const pump = () => {
          if (cancelled) return;
          while (running.size < maxConcurrent && idx < pending.length) {
            const item = pending[idx++];
            const p = worker(item).finally(() => { running.delete(p); pump(); });
            running.add(p);
          }
          if (running.size === 0 && idx >= pending.length) {
            // One-shot refresh
            (async () => {
              try {
                const r = await fetch(ANALYSIS_BASE + '/records', { headers: { Authorization: `Bearer ${token}` } });
                const list = await r.json(); setFiles(Array.isArray(list) ? list : []);
              } catch {}
              setHealing(h => ({ ...h, running: false }));
            })();
          }
        };
        pump();
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [token]);

  const gridCols = useMemo(() => ({ columns: 'repeat(auto-fill, minmax(260px, 1fr))' }), []);

  const displayFiles = useMemo(() => {
    const s = (filterName || '').trim().toLowerCase();
    const mt = (filterType || '').trim().toLowerCase();
    const start = dateStart ? new Date(dateStart) : null;
    const end = dateEnd ? new Date(dateEnd + 'T23:59:59.999') : null;
    let arr = Array.isArray(files) ? [...files] : [];
    arr = arr.filter(f => {
      const created = new Date(f.created_at);
      if (start && created < start) return false;
      if (end && created > end) return false;
      if (s) {
        const name = (f.title || f.filename || '').toLowerCase();
        if (!name.includes(s)) return false;
      }
      if (mt) {
        const mm = (f.mimetype || '').toLowerCase();
        if (!mm.includes(mt)) return false;
      }
      return true;
    });
    arr.sort((a, b) => {
      const da = new Date(a.created_at).getTime();
      const db = new Date(b.created_at).getTime();
      return sortOrder === 'asc' ? da - db : db - da;
    });
    return arr;
  }, [files, filterName, filterType, dateStart, dateEnd, sortOrder]);

  function pickFiles(){ fileInputRef.current?.click(); }

  async function onDelete(id){
    if (!token) { window.location.href = '/auth'; return; }
    const ok = window.confirm('确认删除该分析实例？此操作不可撤销。');
    if (!ok) return;
    try {
      const r = await fetch(ANALYSIS_BASE + `/records/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 204) {
        setFiles(list => list.filter(x => x.id !== id));
      }
    } catch (e) {}
  }

  async function computeFeatures(file){
    const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const channel = audioBuf.getChannelData(0);
    const targetSR = 8000;
    const ratio = Math.max(1, Math.floor(audioBuf.sampleRate / targetSR));
    const ds = new Float32Array(Math.ceil(channel.length / ratio));
    for (let i = 0; i < ds.length; i++) ds[i] = channel[i * ratio] || 0;
    const resp = await fetch(ANALYSIS_BASE + '/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sampleRate: Math.round(audioBuf.sampleRate / ratio), pcm: Array.from(ds) })
    });
    const json = await resp.json();
    return { features: json, payload: { sampleRate: Math.round(audioBuf.sampleRate / ratio), pcm: Array.from(ds) } };
  }

  async function onFiles(e){
    const fl = Array.from(e.target.files || []).slice(0, 10);
    if (!fl.length) return;
    if (!token) { window.location.href = '/auth'; return; }
    setBusy(true); setProgress({ total: fl.length, done: 0 });
    let firstId = null;
    for (let idx = 0; idx < fl.length; idx++){
      const f = fl[idx];
      try {
        const { features, payload } = await computeFeatures(f);
        const fd = new FormData(); fd.append('file', f);
        const up = await fetch(MEDIA_BASE + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fd });
        const meta = await up.json();
        if (!meta?.id) throw new Error('upload failed');
        const rec = await fetch(ANALYSIS_BASE + '/records', {
          method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
          body: JSON.stringify({ mediaId: meta.id, filename: meta.filename, mimetype: meta.mimetype, size: meta.size, features })
        });
        const saved = await rec.json();
        if (saved?.id && !firstId) firstId = saved.id;
        // cache adv/spec in background (do not await)
        (async ()=>{
          try {
            const [advResp, specResp] = await Promise.all([
              fetch(VIZ_BASE + '/pcg_advanced', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) }),
              fetch(VIZ_BASE + '/spectrogram_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ...payload, maxFreq:2000, width:1200, height:320 }) })
            ]);
            let specId = null; let adv = null;
            if (specResp.ok) {
              const imgBlob = await specResp.blob(); const fdu = new FormData();
              fdu.append('file', new File([imgBlob], 'spectrogram.png', { type:'image/png' }));
              const up2 = await fetch(MEDIA_BASE + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fdu });
              const j2 = await up2.json(); if (j2?.id) specId = j2.id;
            }
            if (advResp.ok) adv = await advResp.json();
            if (saved?.id && (adv || specId)){
              await fetch(ANALYSIS_BASE + `/records/${saved.id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ adv: adv || null, specMediaId: specId || null }) });
            }
          } catch {}
        })();
      } catch (err) { console.warn('create failed', err); }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
    setBusy(false);
    // refresh list
    try {
      const r = await fetch(ANALYSIS_BASE + '/records', { headers: { Authorization: `Bearer ${token}` } });
      const list = await r.json(); setFiles(Array.isArray(list)?list:[]);
    } catch {}
    // navigate if single
    if (fl.length === 1 && firstId) window.location.href = `/analysis/${firstId}`;
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  if (token === null) {
    // initial boot; avoid flash
    return (
      <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
        <div>{t('Loading')}</div>
      </div>
    );
  }

  if (!token) {
    return (
      <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('AnalysisTitle')}</h1>
        <p>{t('LoginToView')}</p>
        <a href="/auth" style={{ textDecoration:'none', padding:'10px 14px', borderRadius:8, background:'#111', color:'#fff' }}>{t('Login')}</a>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap: 8 }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('AnalysisTitle')}</h1>
        <div style={{ display:'flex', alignItems:'center', gap:8, position:'relative' }}>
          {/* Filter button */}
          <button onClick={()=>setFiltersOpen(v=>!v)} title="筛选/排序" style={{ padding:'10px 12px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff', cursor:'pointer', display:'inline-flex', alignItems:'center', gap:6 }}>
            {/* Filter icon */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" stroke="#0f172a" strokeWidth="1.5" fill="none"/></svg>
            <span>筛选</span>
          </button>
          {filtersOpen && (
            <div style={{ position:'absolute', right: 110, top: 44, zIndex: 10, width: 320, background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, boxShadow:'0 8px 24px rgba(0,0,0,0.08)', padding:12 }}>
              <div style={{ fontWeight:600, marginBottom:8 }}>筛选与排序</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>开始日期</div>
                  <input type="date" value={dateStart} onChange={e=>setDateStart(e.target.value)} style={{ width:'100%', padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6 }} />
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>结束日期</div>
                  <input type="date" value={dateEnd} onChange={e=>setDateEnd(e.target.value)} style={{ width:'100%', padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6 }} />
                </div>
                <div style={{ gridColumn:'1 / -1' }}>
                  <div style={{ fontSize:12, color:'#64748b' }}>文件名</div>
                  <input type="text" value={filterName} onChange={e=>setFilterName(e.target.value)} placeholder="模糊搜索文件名/标题" style={{ width:'100%', padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6 }} />
                </div>
                <div style={{ gridColumn:'1 / -1' }}>
                  <div style={{ fontSize:12, color:'#64748b' }}>MIME 类型</div>
                  <input type="text" value={filterType} onChange={e=>setFilterType(e.target.value)} placeholder="如 audio/mpeg, audio/wav" style={{ width:'100%', padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6 }} />
                </div>
                <div style={{ gridColumn:'1 / -1' }}>
                  <div style={{ fontSize:12, color:'#64748b', marginBottom:4 }}>按上传时间排序</div>
                  <div style={{ display:'flex', gap:8 }}>
                    <label style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6, cursor:'pointer' }}>
                      <input type="radio" name="sortdate" checked={sortOrder==='desc'} onChange={()=>setSortOrder('desc')} /> 最新在前
                    </label>
                    <label style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:6, cursor:'pointer' }}>
                      <input type="radio" name="sortdate" checked={sortOrder==='asc'} onChange={()=>setSortOrder('asc')} /> 最早在前
                    </label>
                  </div>
                </div>
                <div style={{ gridColumn:'1 / -1', display:'flex', justifyContent:'flex-end', gap:8, marginTop:4 }}>
                  <button onClick={()=>{ setFilterName(''); setFilterType(''); setDateStart(''); setDateEnd(''); setSortOrder('desc'); }} style={{ padding:'6px 10px', background:'#f1f5f9', border:'1px solid #e5e7eb', borderRadius:6, cursor:'pointer' }}>重置</button>
                  <button onClick={()=>setFiltersOpen(false)} style={{ padding:'6px 10px', background:'#111', color:'#fff', border:'1px solid #111', borderRadius:6, cursor:'pointer' }}>完成</button>
                </div>
              </div>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept="audio/*" multiple onChange={onFiles} style={{ display:'none' }} />
          <button onClick={pickFiles} style={{ textDecoration:'none', padding:'10px 14px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff', cursor:'pointer' }}>{t('NewAnalysis')}</button>
        </div>
      </div>
      {busy && (
        <div style={{ marginBottom:12, display:'flex', alignItems:'center', gap:8, color:'#64748b' }}>
          <div className="vh-spin" />
          <div>Uploading {progress.done} / {progress.total} …</div>
          <style>{`.vh-spin{width:20px;height:20px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:9999px;animation:vh-rot 0.8s linear infinite}@keyframes vh-rot{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
      {healing.running && (
        <div style={{ marginBottom:12, display:'flex', alignItems:'center', gap:8, color:'#64748b' }}>
          <div className="vh-spin" />
          <div>Preparing results {healing.done} / {healing.total} …</div>
        </div>
      )}
      {loading && <div>{t('Loading')}</div>}
      {!loading && files.length === 0 && (
        <div style={{ color:'#64748b' }}>{t('NoRecords')}</div>
      )}
      <div style={{ display:'grid', gridTemplateColumns: gridCols.columns, gap: 12 }}>
        {displayFiles.map(f => (
          <div key={f.id} style={{ position:'relative' }}>
            {/* Delete icon in top-right */}
            <button onClick={(e)=>{ e.stopPropagation(); onDelete(f.id); }} title="删除此实例" style={{ position:'absolute', right:8, top:8, zIndex:2, background:'transparent', border:'none', cursor:'pointer' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9z" fill="#dc2626"/></svg>
            </button>
            <a href={`/analysis/${f.id}`} style={{ textDecoration:'none', color:'inherit', display:'block' }}>
              <div style={{ border:'1px solid #e5e7eb', borderRadius: 12, padding: 12, background:'#fff', minHeight: 96 }}>
                <div style={{ fontWeight:600, marginBottom:6, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', paddingRight:18 }}>{f.title || f.filename}</div>
                <div style={{ color:'#64748b', fontSize:13 }}>{new Date(f.created_at).toLocaleString()}</div>
                <div style={{ color:'#64748b', fontSize:13, marginTop:6 }}>{f.mimetype} · {(f.size/1024).toFixed(1)} KB</div>
              </div>
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}
