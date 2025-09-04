"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../../components/i18n';

import WaveSurfer from 'wavesurfer.js';

const VIZ_BASE = process.env.NEXT_PUBLIC_API_VIZ || 'http://localhost:4006';

const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';
const ANALYSIS_BASE = process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004';

export default function AnalysisDetail({ params }) {
  const { t } = useI18n();
  const { id } = params;
  const [token, setToken] = useState(null);
  const [meta, setMeta] = useState(null);
  const [features, setFeatures] = useState(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [extra, setExtra] = useState(null);
  const [pxPerSec, setPxPerSec] = useState(80);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const waveWrapRef = useRef(null);
  const rulerRef = useRef(null);
  const audioRef = useRef(null);
  const wsRef = useRef(null);
  const lastXRef = useRef(0);
  const isDraggingRef = useRef(false);
  const pinchRef = useRef({ active:false, id1:null, id2:null, startDist:0, startPx:0, startScroll:0 });
  const [specUrl, setSpecUrl] = useState(null);
  const [adv, setAdv] = useState(null);
  const [loading, setLoading] = useState({ decode: false, extra: false, adv: false, spec: false });
  const [progress, setProgress] = useState(0);
  const [audioError, setAudioError] = useState(null);

  useEffect(() => { setToken(localStorage.getItem('vh_token')); }, []);

  useEffect(() => {
    if (!token) return;
    (async () => {
      const r = await fetch(ANALYSIS_BASE + `/records/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return;
      const rec = await r.json();
      setMeta(rec);
      setFeatures(rec.features || null);
      setTitle(rec.title || rec.filename || '');
      // if cached advanced or spectrogram exist, load immediately
      if (rec.adv) setAdv(rec.adv);
      if (rec.spec_media_id) {
        try {
          const fr = await fetch(MEDIA_BASE + `/file/${rec.spec_media_id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (fr.ok) { const b = await fr.blob(); setSpecUrl(URL.createObjectURL(b)); }
        } catch {}
      }
    })();
  }, [id, token]);

  // Load audio blob URL only (render handled by WaveSurfer)
  useEffect(() => {
    if (!token || !meta) return;
    (async () => {
      const r = await fetch(MEDIA_BASE + `/file/${meta.media_id}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setAudioError('无法加载音频文件（可能的权限或密钥问题）'); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      // compute extra features once (off-UI path)
      try {
        setLoading(s=>({ ...s, decode:true, extra:true, adv:true, spec:true })); setProgress(0);
        const arr = await blob.arrayBuffer();
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buf = await audioCtx.decodeAudioData(arr.slice(0));
        const ch = buf.getChannelData(0);
        // downsample to ~8k to limit payload
        const targetSR = 8000;
        const ratio = Math.max(1, Math.floor(buf.sampleRate / targetSR));
        const ds = new Float32Array(Math.ceil(ch.length / ratio));
        for (let i = 0; i < ds.length; i++) ds[i] = ch[i * ratio] || 0;
        setLoading(s=>({ ...s, decode:false })); setProgress(p=>p+0.25);
        const payload = { sampleRate: Math.round(buf.sampleRate / ratio), pcm: Array.from(ds) };
        // run in parallel
        const featuresP = (async ()=>{
          const resp = await fetch(VIZ_BASE + '/features_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
          if (resp.ok) setExtra(await resp.json());
          setLoading(s=>({ ...s, extra:false })); setProgress(p=>p+0.25);
        })();
        const advP = (async ()=>{
          const resp = await fetch(VIZ_BASE + '/pcg_advanced', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
          if (resp.ok) setAdv(await resp.json());
          setLoading(s=>({ ...s, adv:false })); setProgress(p=>p+0.25);
        })();
        const width = Math.max(800, Math.min(1400, Math.floor((typeof window!=='undefined'? window.innerWidth:1200) - 80)));
        const specP = (async ()=>{
          const resp = await fetch(VIZ_BASE + '/spectrogram_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ...payload, maxFreq:2000, width, height: 320 }) });
          if (resp.ok) {
            const imgBlob = await resp.blob();
            setSpecUrl(URL.createObjectURL(imgBlob));
            // cache spectrogram into media and patch record
            try {
              const fd = new FormData();
              fd.append('file', new File([imgBlob], 'spectrogram.png', { type: 'image/png' }));
              const up = await fetch((process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003') + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fd });
              const j = await up.json();
              if (j?.id) {
                await fetch(ANALYSIS_BASE + `/records/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ specMediaId: j.id }) });
              }
            } catch {}
          }
          setLoading(s=>({ ...s, spec:false })); setProgress(p=>p+0.25);
        })();
        await Promise.allSettled([featuresP, advP, specP]);
        // cache adv to record if not present
        try {
          if (!meta?.adv && adv) {
            await fetch(ANALYSIS_BASE + `/records/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ adv }) });
          }
        } catch {}
      } catch {}
    })();
  }, [meta, token]);
  // Init WaveSurfer bound to the HTMLAudioElement (so bottom control bar controls everything)
  useEffect(() => {
    if (!audioUrl || !waveWrapRef.current || !audioRef.current) return;
    if (wsRef.current) { try { wsRef.current.destroy(); } catch {} wsRef.current = null; }
    const ws = WaveSurfer.create({
      container: waveWrapRef.current,
      media: audioRef.current,
      height: 160,
      minPxPerSec: pxPerSec,
      waveColor: '#94a3b8',
      progressColor: '#111827',
      normalize: true,
      interact: false, // disable seeking by click; playback controlled by audio element
    });
    ws.on('ready', () => {
      const d = ws.getDuration();
      setDuration(d);
      const cw = waveWrapRef.current?.clientWidth || 800;
      const minPx = d > 0 ? (cw / d) : 100;
      setPxPerSec(minPx);
      ws.zoom(minPx);
    });
    wsRef.current = ws;
    return () => {
      try { ws.destroy(); } catch {}
    };
  }, [audioUrl]);

  // Zoom handler via wheel/pinch; Pan via drag or horizontal wheel
  const onWheelNative = useCallback((e) => {
    if (!waveWrapRef.current || !wsRef.current || !duration) return;
    e.preventDefault();
    e.stopPropagation();
    const wrapper = waveWrapRef.current;
    const rect = wrapper.getBoundingClientRect();
    const isZoom = e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX);
    const currentPx = pxPerSec;
    const minPx = duration > 0 ? (rect.width / duration) : 10;
    const totalW = wrapper.scrollWidth || (currentPx * (duration || 0));
    const secPerPx = (duration && totalW) ? (duration / totalW) : (1 / currentPx);
    if (isZoom) {
      const x = e.clientX - rect.left;
      const frac = Math.max(0, Math.min(1, x / rect.width));
      const pivotSec = (wrapper.scrollLeft + x) * secPerPx;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const next = Math.max(minPx, Math.min(5000, currentPx * (1 / factor)));
      setPxPerSec(next);
      wsRef.current.zoom(next);
      const newScrollLeft = Math.max(0, pivotSec * next - frac * rect.width);
      const maxScroll = Math.max(0, next * duration - rect.width);
      // Apply after zoom paint to ensure alignment
      requestAnimationFrame(() => {
        wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, newScrollLeft));
      });
    } else {
      const current = wrapper.scrollLeft + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      const maxScroll = Math.max(0, currentPx * duration - rect.width);
      wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, current));
    }
  }, [duration, pxPerSec]);

  useEffect(() => {
    const el = waveWrapRef.current; if (!el) return;
    // Add non-passive wheel/gesture handlers to prevent page zoom/scroll
    el.addEventListener('wheel', onWheelNative, { passive: false });
    const prevent = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    el.addEventListener('gesturestart', prevent, { passive: false });
    el.addEventListener('gesturechange', prevent, { passive: false });
    el.style.overscrollBehavior = 'contain';
    return () => {
      el.removeEventListener('wheel', onWheelNative);
      el.removeEventListener('gesturestart', prevent);
      el.removeEventListener('gesturechange', prevent);
    };
  }, [onWheelNative]);

  const downXRef = useRef(0);
  const movedRef = useRef(false);
  function onMouseDown(e){ isDraggingRef.current = true; downXRef.current = lastXRef.current = e.clientX; movedRef.current = false; }
  function onMouseMove(e){
    if (!isDraggingRef.current) return;
    const wrapper = waveWrapRef.current; if (!wrapper) return;
    const dx = e.clientX - lastXRef.current; lastXRef.current = e.clientX;
    const rect = wrapper.getBoundingClientRect();
    const pps = wsRef.current?.options?.minPxPerSec || pxPerSec;
    const maxScroll = Math.max(0, pps * duration - rect.width);
    if (Math.abs(e.clientX - downXRef.current) > 3) movedRef.current = true;
    wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, wrapper.scrollLeft - dx)); // drag to pan with bounds
  }
  function onMouseUp(e){
    const wrapper = waveWrapRef.current; if (!wrapper) { isDraggingRef.current = false; return; }
    // Click-to-seek if not dragging
    if (!movedRef.current && duration) {
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const sec = Math.max(0, Math.min(duration, (wrapper.scrollLeft + x) / pxPerSec));
      if (audioRef.current) audioRef.current.currentTime = sec;
    }
    isDraggingRef.current = false;
  }

  // Pinch zoom with two pointers
  function onPointerDown(e){
    const el = waveWrapRef.current; if (!el) return; el.setPointerCapture?.(e.pointerId);
    if (pinchRef.current.active) return;
    if (pinchRef.current.id1 == null) pinchRef.current.id1 = e.pointerId; else if (pinchRef.current.id2 == null) pinchRef.current.id2 = e.pointerId;
    const ids = [pinchRef.current.id1, pinchRef.current.id2].filter(v=>v!=null);
    if (ids.length === 2) {
      pinchRef.current.active = true;
      pinchRef.current.startDist = 0;
      pinchRef.current.startPx = pxPerSec;
      pinchRef.current.startScroll = el.scrollLeft;
    }
  }
  function onPointerUp(e){
    const el = waveWrapRef.current; if (!el) return; el.releasePointerCapture?.(e.pointerId);
    if (pinchRef.current.id1 === e.pointerId) pinchRef.current.id1 = null;
    if (pinchRef.current.id2 === e.pointerId) pinchRef.current.id2 = null;
    if (!pinchRef.current.id1 || !pinchRef.current.id2) pinchRef.current.active = false;
  }
  function onPointerMove(e){
    const el = waveWrapRef.current; if (!el || !pinchRef.current.active) return;
    // We can't get both touches easily without storing their positions; use TouchEvent fallback
  }

  // Touch pinch (fallback using TouchEvents)
  function onTouchMove(e){
    if (e.touches.length === 2 && waveWrapRef.current && wsRef.current) {
      e.preventDefault();
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const rect = waveWrapRef.current.getBoundingClientRect();
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      if (pinchRef.current.startDist === 0) {
        pinchRef.current.startDist = dist;
        pinchRef.current.startScroll = waveWrapRef.current.scrollLeft;
        pinchRef.current.startPx = pxPerSec;
      } else {
        const scale = dist / pinchRef.current.startDist;
        const centerX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const frac = Math.max(0, Math.min(1, centerX / rect.width));
        const pivotSec = (waveWrapRef.current.scrollLeft + centerX) / pxPerSec;
        const minPx = duration > 0 ? (rect.width / duration) : 10;
        const next = Math.max(minPx, Math.min(5000, pinchRef.current.startPx * scale));
        setPxPerSec(next);
        wsRef.current.zoom(next);
        const newScrollLeft = Math.max(0, pivotSec * next - frac * rect.width);
        const maxScroll = Math.max(0, next * duration - rect.width);
        waveWrapRef.current.scrollLeft = Math.max(0, Math.min(maxScroll, newScrollLeft));
      }
    }
  }
  function onTouchEnd(){ pinchRef.current.startDist = 0; }

  // Time ruler (clamped to duration)
  useEffect(() => {
    function draw() {
      const c = rulerRef.current; const wrap = waveWrapRef.current; if (!c || !wrap || !wsRef.current) return;
      const ctx = c.getContext('2d');
      const w = wrap.clientWidth; const h = 26; c.width = w * devicePixelRatio; c.height = h * devicePixelRatio; c.style.height = h + 'px';
      ctx.setTransform(1,0,0,1,0,0);
      ctx.scale(devicePixelRatio, devicePixelRatio);
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,w,h);
      ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(0, h-0.5); ctx.lineTo(w, h-0.5); ctx.stroke();
      const pps = pxPerSec; // use state for current zoom (px/sec)
      const scroll = wrap.scrollLeft || 0;
      const startSec = scroll / pps;
      const viewSec = w / pps;
      const endSec = Math.min(duration || 0, startSec + viewSec);
      // Choose tick spacing
      const steps = [0.001,0.002,0.005,0.01,0.02,0.05,0.1,0.2,0.5,1,2,5,10];
      let step = 1; for (const s of steps) { if (s * pps >= 60) { step = s; break; } }
      const first = Math.floor(startSec / step) * step;
      ctx.fillStyle = '#64748b'; ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
      for (let t = first; t <= endSec + 1e-9; t += step) {
        const x = Math.round((t - startSec) * pps) + 0.5;
        const isMajor = (Math.abs((t/ (step*5)) - Math.round(t/(step*5))) < 1e-6);
        const tick = isMajor ? 10 : 6;
        ctx.strokeStyle = '#cbd5e1'; ctx.beginPath(); ctx.moveTo(x, h-1); ctx.lineTo(x, h-1-tick); ctx.stroke();
        const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
        const label = Math.max(0, Math.min(duration || 0, t)).toFixed(decimals);
        if (isMajor) ctx.fillText(label + 's', x + 2, 12);
      }
      // Playhead marker
      const a = audioRef.current; if (a) {
        const playX = (Math.max(0, Math.min(duration || 0, a.currentTime)) - startSec) * pps;
        ctx.strokeStyle = '#ef4444'; ctx.beginPath(); ctx.moveTo(playX+0.5, 0); ctx.lineTo(playX+0.5, h); ctx.stroke();
      }
      // Draw total duration at the far right when full view is shown
      if ((duration || 0) > 0 && viewSec >= (duration || 0) - 1e-6) {
        const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
        const text = (duration || 0).toFixed(decimals) + 's';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = '#334155';
        ctx.fillText(text, Math.max(0, w - tw - 4), 12);
      }
      requestAnimationFrame(draw);
    }
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [pxPerSec, duration]);

  if (!token) return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <a href="/analysis" style={{ textDecoration:'none', color:'#2563eb' }}>{t('Back')}</a>
      <div>{t('LoginToView')}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <a href="/analysis" style={{ textDecoration:'none', color:'#2563eb' }}>{t('Back')}</a>
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        {!editing ? (
          <>
            <h1 style={{ fontSize: 24, margin: '12px 0' }}>{title || (meta?.filename || '') || t('AnalysisTitle')}</h1>
            <button onClick={()=>setEditing(true)} title={t('EditTitle')} style={{ border:'none', background:'transparent', cursor:'pointer', color:'#64748b' }}>✎</button>
          </>
        ) : (
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <input value={title} onChange={e=>setTitle(e.target.value)} placeholder={t('Title')} style={{ padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:8 }} />
            <button onClick={async ()=>{
              try {
                const resp = await fetch(ANALYSIS_BASE + `/records/${id}`, {
                  method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ title })
                });
                const json = await resp.json();
                if (json?.id) { setMeta(m=>({ ...(m||{}), title })); setEditing(false); }
              } catch {}
            }} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>{t('Save')}</button>
            <button onClick={()=>{ setTitle(meta?.title || meta?.filename || ''); setEditing(false); }} style={{ padding:'6px 10px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>{t('Cancel')}</button>
          </div>
        )}
      </div>
      {/* Sub-title: Waveform */}
      <div style={{ fontSize: 18, fontWeight: 600, margin: '8px 0 6px' }}>{t('Waveform')}</div>
      {meta && (
        <div style={{ color:'#64748b', fontSize:13, marginBottom:8 }}>{new Date(meta.created_at).toLocaleString()} · {meta.mimetype} · {(meta.size/1024).toFixed(1)} KB</div>
      )}

      {/* Waveform (client-rendered, smooth) */}
      { (loading.decode || loading.extra || loading.adv || loading.spec) && (
        <div style={{ marginTop:8, height:6, background:'#e5e7eb', borderRadius:6, overflow:'hidden' }}>
          <div style={{ width: `${Math.round(Math.min(1, progress)*100)}%`, height:'100%', background:'#2563eb', transition:'width 200ms linear' }} />
        </div>
      )}
      {audioError ? (
        <div style={{ padding:12, color:'#b91c1c', background:'#fef2f2', border:'1px solid #fecaca', borderRadius:12 }}>
          {audioError}
        </div>
      ) : (
        <div
          ref={waveWrapRef}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          style={{ position:'relative', userSelect:'none', background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflowX:'auto', overflowY:'hidden', touchAction:'none' }}
        />
      )}

      {/* Time ruler under waveform */}
      <canvas ref={rulerRef} style={{ width:'100%' }} />

      {audioUrl && (
        <audio ref={audioRef} controls src={audioUrl} style={{ marginTop: 8, width:'100%' }} />
      )}

      {/* Sub-title: Spectrogram */}
      <div style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px' }}>{t('Spectrogram')}</div>
      {/* Static spectrogram below playback bar (colored, with axes) */}
      <div style={{ marginTop: 12, background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', minHeight: 200, position:'relative' }}>
        {!specUrl && (
          <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', color:'#64748b' }}>
            <div className="vh-spin" />
          </div>
        )}
        {specUrl && <img src={specUrl} alt="spectrogram" style={{ display:'block', width:'100%', height:'auto' }} />}
      </div>
      <style>{`.vh-spin{width:28px;height:28px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:9999px;animation:vh-rot 0.8s linear infinite}@keyframes vh-rot{to{transform:rotate(360deg)}}`}</style>

      {/* Clinical PCG Analysis */}
      {adv && (
        <>
          <div style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px' }}>{t('ClinicalAnalysis')}</div>
          <div style={{ background: '#f8fafc', padding: 16, borderRadius: 12 }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0,1fr))', gap:12 }}>
            <div><b>{t('HeartRate')}:</b> {adv.hrBpm ? adv.hrBpm.toFixed(0) : '—'}</div>
            <div><b>{t('RRMean')}:</b> {adv.rrMeanSec?.toFixed?.(3) || '—'}</div>
            <div><b>{t('RRStd')}:</b> {adv.rrStdSec?.toFixed?.(3) || '—'}</div>
            <div><b>{t('Systole')}:</b> {adv.systoleMs?.toFixed?.(0) || '—'}</div>
            <div><b>{t('Diastole')}:</b> {adv.diastoleMs?.toFixed?.(0) || '—'}</div>
            <div><b>{t('DSRatio')}:</b> {adv.dsRatio?.toFixed?.(2) || '—'}</div>
            <div><b>{t('S2Split')}:</b> {adv.s2SplitMs?.toFixed?.(1) || '—'}</div>
            <div><b>{t('A2OS')}:</b> {adv.a2OsMs?.toFixed?.(1) || '—'}</div>
            <div><b>{t('S1Intensity')}:</b> {adv.s1Intensity?.toFixed?.(3) || '—'}</div>
            <div><b>{t('S2Intensity')}:</b> {adv.s2Intensity?.toFixed?.(3) || '—'}</div>
            <div><b>{t('SysHF')}:</b> {adv.sysHighFreqEnergy ? adv.sysHighFreqEnergy.toFixed(2) : '—'}</div>
            <div><b>{t('DiaHF')}:</b> {adv.diaHighFreqEnergy ? adv.diaHighFreqEnergy.toFixed(2) : '—'}</div>
            <div><b>{t('SysShape')}:</b> {adv.sysShape || '—'}</div>
            <div><b>{t('SNR')}:</b> {adv.qc?.snrDb?.toFixed?.(1) || '—'}</div>
            <div><b>{t('MotionPct')}:</b> {adv.qc ? Math.round(adv.qc.motionPct*100) : '—'}</div>
            <div><b>{t('UsablePct')}:</b> {adv.qc ? Math.round(adv.qc.usablePct*100) : '—'}</div>
          </div>
            <div style={{ gridColumn:'1 / -1', marginTop: 6, fontSize: 12, color:'#64748b' }}>{t('Disclaimer')}</div>
          </div>
        </>
      )}

      {(features || extra) && (
        <>
          <div style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px' }}>{t('Features')}</div>
          <div style={{ background: '#f8fafc', padding: 16, borderRadius: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 }}>
            {features && (
              <>
                <div><b>{t('Duration')}:</b> {features.durationSec?.toFixed?.(2)}</div>
                <div><b>{t('SampleRate')}:</b> {features.sampleRate}</div>
                <div><b>{t('RMS')}:</b> {features.rms?.toFixed?.(4)}</div>
                <div><b>{t('ZCR')}:</b> {Math.round(features.zcrPerSec)}</div>
                {features.peakRatePerSec!=null && <div><b>{t('PeakRate')}:</b> {features.peakRatePerSec?.toFixed?.(2)}</div>}
              </>
            )}
            {extra && (
              <>
                <div><b>{t('SpectralCentroid')}:</b> {Math.round(extra.spectralCentroid)} Hz</div>
                <div><b>{t('Bandwidth')}:</b> {Math.round(extra.spectralBandwidth)} Hz</div>
                <div><b>{t('Rolloff95')}:</b> {Math.round(extra.rolloff95)} Hz</div>
                <div><b>{t('Flatness')}:</b> {extra.spectralFlatness?.toFixed?.(4)}</div>
                <div><b>{t('Flux')}:</b> {extra.spectralFlux?.toFixed?.(4)}</div>
                <div><b>{t('CrestFactor')}:</b> {extra.crestFactor?.toFixed?.(2)}</div>
              </>
            )}
          </div>
          </div>
        </>
      )}
    </div>
  );
}
