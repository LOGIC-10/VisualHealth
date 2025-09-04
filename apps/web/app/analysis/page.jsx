"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';

const ANALYSIS_BASE = process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';
const VIZ_BASE = process.env.NEXT_PUBLIC_API_VIZ || 'http://localhost:4006';

export default function AnalysisListPage() {
  const { t } = useI18n();
  const [token, setToken] = useState(null);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ total: 0, done: 0 });
  const fileInputRef = useRef(null);

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    setToken(t);
    if (!t) { setLoading(false); return; }
    (async () => {
      try {
        const r = await fetch(ANALYSIS_BASE + '/records', { headers: { Authorization: `Bearer ${t}` } });
        const list = await r.json();
        setFiles(Array.isArray(list) ? list : []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const gridCols = useMemo(() => ({ columns: 'repeat(auto-fill, minmax(260px, 1fr))' }), []);

  function pickFiles(){ fileInputRef.current?.click(); }

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
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: '0 24px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('AnalysisTitle')}</h1>
        <div>
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
      {loading && <div>{t('Loading')}</div>}
      {!loading && files.length === 0 && (
        <div style={{ color:'#64748b' }}>{t('NoRecords')}</div>
      )}
      <div style={{ display:'grid', gridTemplateColumns: gridCols.columns, gap: 12 }}>
        {files.map(f => (
          <a key={f.id} href={`/analysis/${f.id}`} style={{ textDecoration:'none', color:'inherit' }}>
            <div style={{ border:'1px solid #e5e7eb', borderRadius: 12, padding: 12, background:'#fff' }}>
              <div style={{ fontWeight:600, marginBottom:6, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.title || f.filename}</div>
              <div style={{ color:'#64748b', fontSize:13 }}>{new Date(f.created_at).toLocaleString()}</div>
              <div style={{ color:'#64748b', fontSize:13, marginTop:6 }}>{f.mimetype} · {(f.size/1024).toFixed(1)} KB</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
