"use client";
import { useEffect, useRef, useState, useCallback } from 'react';
import Link from 'next/link';
import { useI18n } from '../components/i18n';
import { renderMarkdown } from '../components/markdown';
import WaveSurfer from 'wavesurfer.js';
import { API } from '../lib/api';
// Spectrogram plugin removed; use server-rendered demo spectrogram instead

function makeHeartbeatWav(seconds=6, sampleRate=8000){
  const sr = sampleRate; const N = seconds*sr|0; const ch = new Float32Array(N);
  const beats = []; let t=0; const rr=0.8; while(t<seconds){ beats.push(t); t+=rr; }
  function addPulse(at, freq, dur, gain){ const start=(at*sr)|0; const len=(dur*sr)|0; for(let i=0;i<len && start+i<N;i++){ const env=Math.exp(-3*i/len); ch[start+i]+=gain*env*Math.sin(2*Math.PI*freq*i/sr); } }
  for (const b of beats){ addPulse(b+0.02, 120, 0.08, 0.8); addPulse(b+0.32, 180, 0.06, 0.6); }
  // WAV encode PCM16
  const buf = new ArrayBuffer(44+N*2); const dv = new DataView(buf);
  function w32(o,v){ dv.setUint32(o,v,true);} function w16(o,v){ dv.setUint16(o,v,true);} function w8s(o,s){ for(let i=0;i<s.length;i++) dv.setUint8(o+i,s.charCodeAt(i)); }
  w8s(0,'RIFF'); w32(4,36+N*2); w8s(8,'WAVE'); w8s(12,'fmt '); w32(16,16); w16(20,1); w16(22,1); w32(24,sr); w32(28,sr*2); w16(32,2); w16(34,16); w8s(36,'data'); w32(40,N*2);
  let o=44; for(let i=0;i<N;i++){ let v=Math.max(-1,Math.min(1,ch[i])); dv.setInt16(o, v*32767, true); o+=2; }
  return new Blob([dv], { type:'audio/wav' });
}

const VIZ_BASE = API.viz;

function Demo(){
  const waveWrapRef = useRef(null); const audioRef = useRef(null); const wsRef = useRef(null); const urlRef = useRef('');
  const [pxPerSec, setPxPerSec] = useState(120);
  const [duration, setDuration] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [specUrl, setSpecUrl] = useState(null);

  useEffect(()=>{
    const blob = makeHeartbeatWav(8, 8000);
    const url = URL.createObjectURL(blob); urlRef.current = url;
    if (audioRef.current){ audioRef.current.src = url; audioRef.current.load(); }
    // Setup WaveSurfer
    const ws = WaveSurfer.create({
      container: waveWrapRef.current,
      media: audioRef.current,
      height: 120,
      minPxPerSec: pxPerSec,
      waveColor:'#94a3b8',
      progressColor:'#111827',
      normalize:true,
      interact:false,
    });
    ws.on('ready', () => {
      const d = ws.getDuration(); setDuration(d);
      const wrap = waveWrapRef.current; const cw = wrap?.clientWidth || 800;
      const minPx = d > 0 ? Math.max(80, cw / d) : 120;
      setPxPerSec(minPx); ws.zoom(minPx);
    });
    wsRef.current = ws;

    // Prepare server-rendered spectrogram for the same demo signal
    (async () => {
      try {
        // Decode the blob back to PCM (small clip so OK)
        const arr = await (await fetch(url)).arrayBuffer();
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        const ctx = new AC(); const buf = await ctx.decodeAudioData(arr.slice(0));
        const ch = buf.getChannelData(0);
        const payload = { sampleRate: buf.sampleRate, pcm: Array.from(ch) };
        const width = Math.max(800, Math.min(1400, Math.floor((typeof window!=='undefined'? window.innerWidth:1200) - 80)));
        const resp = await fetch(VIZ_BASE + '/spectrogram_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ...payload, maxFreq:2000, width, height: 280 }) });
        if (resp.ok) { const b = await resp.blob(); setSpecUrl(URL.createObjectURL(b)); }
        try { await ctx.close?.(); } catch {}
      } catch {}
    })();

    return ()=>{ try{ws.destroy();}catch{} if (urlRef.current) URL.revokeObjectURL(urlRef.current); if (specUrl) URL.revokeObjectURL(specUrl); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const onWheel = useCallback((e) => {
    const wrap = waveWrapRef.current; const ws = wsRef.current; if (!wrap || !ws || !duration) return;
    e.preventDefault(); e.stopPropagation();
    const rect = wrap.getBoundingClientRect();
    const isZoom = e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX);
    const current = pxPerSec; const minPx = duration > 0 ? (rect.width / duration) : 10;
    const totalW = wrap.scrollWidth || (current * duration);
    const secPerPx = (duration && totalW) ? (duration / totalW) : (1 / current);
    if (isZoom) {
      const x = e.clientX - rect.left; const frac = Math.max(0, Math.min(1, x / rect.width));
      const pivotSec = (wrap.scrollLeft + x) * secPerPx;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const next = Math.max(minPx, Math.min(5000, current * (1 / factor)));
      setPxPerSec(next); ws.zoom(next);
      const newScrollLeft = Math.max(0, pivotSec * next - frac * rect.width);
      const maxScroll = Math.max(0, next * duration - rect.width);
      requestAnimationFrame(() => { wrap.scrollLeft = Math.max(0, Math.min(maxScroll, newScrollLeft)); });
    } else {
      const nextScroll = wrap.scrollLeft + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
      const maxScroll = Math.max(0, current * duration - rect.width);
      wrap.scrollLeft = Math.max(0, Math.min(maxScroll, nextScroll));
    }
  }, [duration, pxPerSec]);

  useEffect(() => {
    const el = waveWrapRef.current; if (!el) return;
    el.addEventListener('wheel', onWheel, { passive:false });
    const preventGesture = (ev)=>{ ev.preventDefault(); ev.stopPropagation(); };
    el.addEventListener('gesturestart', preventGesture, { passive:false });
    el.addEventListener('gesturechange', preventGesture, { passive:false });
    el.style.overscrollBehavior = 'contain';
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', preventGesture);
      el.removeEventListener('gesturechange', preventGesture);
    };
  }, [onWheel]);

  useEffect(() => {
    function onKey(ev){
      if (!hovered) return;
      if (ev.code === 'Space') { ev.preventDefault(); ev.stopPropagation(); const a = audioRef.current; if (a){ if (a.paused) a.play(); else a.pause(); } }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hovered]);

  return (
    <div>
      <div
        ref={waveWrapRef}
        tabIndex={0}
        onMouseEnter={()=>setHovered(true)}
        onMouseLeave={()=>setHovered(false)}
        style={{ border:'1px solid #e5e7eb', borderRadius:12, overflowX:'auto', overflowY:'hidden', background:'#fff' }}
      />
      <div style={{ marginTop:8, border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', background:'#fff', minHeight: 160 }}>
        {!specUrl && (
          <div style={{ height:160, display:'grid', placeItems:'center', color:'#64748b' }}><div className="vh-spin" /></div>
        )}
        {specUrl && <img src={specUrl} alt="demo spectrogram" style={{ display:'block', width:'100%', height:'auto' }} />}
      </div>
      <audio ref={audioRef} controls style={{ marginTop:8, width:'100%' }} />
      <style>{`.vh-spin{width:22px;height:22px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:9999px;animation:vh-rot 0.8s linear infinite}@keyframes vh-rot{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

export default function HomePage() {
  const { t } = useI18n();
  const [guide, setGuide] = useState(false);
  const [token, setToken] = useState(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ total: 0, done: 0 });
  const fileInputRef = useRef(null);
  const ANALYSIS_BASE = API.analysis;
  const MEDIA_BASE = API.media;
  useEffect(()=>{ setToken(localStorage.getItem('vh_token')); },[]);

  function openGuide(){ if(!token){ window.location.href='/auth'; return; } setGuide(true); }
  function pickFiles(){ fileInputRef.current?.click(); }

  async function computeFeatures(file){
    const srTarget = 8000; const arrayBuffer = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const ch = buf.getChannelData(0);
    const ratio = Math.max(1, Math.floor(buf.sampleRate / srTarget));
    const ds = new Float32Array(Math.ceil(ch.length / ratio));
    for (let i=0;i<ds.length;i++) ds[i] = ch[i*ratio] || 0;
    const resp = await fetch(ANALYSIS_BASE + '/analyze', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ sampleRate: Math.round(buf.sampleRate/ratio), pcm: Array.from(ds) }) });
    return await resp.json();
  }

  async function onFiles(e){
    const fl = Array.from(e.target.files || []).slice(0, 10);
    if (!fl.length) return;
    setBusy(true); setProgress({ total: fl.length, done: 0 });
    for (let i=0;i<fl.length;i++){
      try{
        const f = fl[i];
        const features = await computeFeatures(f);
        const fd = new FormData(); fd.append('file', f);
        const up = await fetch(MEDIA_BASE + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fd });
        const meta = await up.json(); if(!meta?.id) throw new Error('upload failed');
        await fetch(ANALYSIS_BASE + '/records', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ mediaId: meta.id, filename: meta.filename, mimetype: meta.mimetype, size: meta.size, features }) });
      }catch(err){ console.warn('create failed', err); }
      setProgress(p=>({ ...p, done: p.done+1 }));
    }
    setBusy(false); setGuide(false);
    window.location.href = '/analysis';
  }
  return (
    <div>
      {/* 1. Hero */}
      <section style={{ minHeight: '80vh', display: 'grid', alignItems: 'center', padding: '80px 24px' }}>
        <div style={{ maxWidth: 920, margin: '0 auto' }}>
          <h1 style={{ fontSize: 56, lineHeight: 1.05, margin: 0 }}>{t('HomeHeroTitle')}</h1>
          <p style={{ fontSize: 20, marginTop: 16 }}>{t('HomeHeroDesc')}</p>
          <div style={{ display: 'flex', gap: 16, marginTop: 28 }}>
            <button onClick={openGuide} className="vh-btn vh-btn-primary vh-btn-lg">{t('GetStarted')}</button>
            <Link href="/community" className="vh-btn vh-btn-outline vh-btn-lg" style={{ textDecoration: 'none' }}>{t('ExploreCommunity')}</Link>
          </div>
        </div>
      </section>
      {/* 2. Feature cards */}
      <section style={{ padding: '64px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 16 }}>{t('HomeFeaturesTitle')}</h2>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4, minmax(0,1fr))', gap:12 }}>
            {[{t:t('Feat1Title'),d:t('Feat1Desc')},{t:t('Feat2Title'),d:t('Feat2Desc')},{t:t('Feat3Title'),d:t('Feat3Desc')},{t:t('Feat4Title'),d:t('Feat4Desc')}].map((c,i)=> (
              <div key={i} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:16, padding:16, minHeight:140 }}>
                <div style={{ fontWeight:600, marginBottom:6 }}>{c.t}</div>
                <div style={{ color:'#475569', fontSize:14 }}>{c.d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* 3. Interactive Demo */}
      <section style={{ padding: '64px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 8 }}>{t('DemoTitle')}</h2>
          <p style={{ color:'#475569', marginBottom:12 }}>{t('DemoDesc')}</p>
          <Demo />
        </div>
      </section>
      {/* 3.5 AI Promo */}
      <section style={{ padding: '64px 24px', background: 'linear-gradient(180deg, #f8fafc, #ffffff)' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0,1fr))', gap:20, alignItems:'stretch' }}>
            <div>
              <h2 style={{ fontSize: 32, marginBottom: 8 }}>{t('HomeAITitle')}</h2>
              <p style={{ color:'#475569', marginBottom:20 }}>{t('HomeAIDesc')}</p>
              <div style={{ display:'grid', gap:12 }}>
                {[{t:t('HomeAIPillar1Title'),d:t('HomeAIPillar1Desc')},{t:t('HomeAIPillar2Title'),d:t('HomeAIPillar2Desc')},{t:t('HomeAIPillar3Title'),d:t('HomeAIPillar3Desc')}].map((c,i)=> (
                  <div key={i} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:16, padding:16, display:'flex', alignItems:'flex-start', gap:12 }}>
                    <div style={{ width:28, height:28, minWidth:28, minHeight:28, flexShrink:0, borderRadius:9999, background:'#111', color:'#fff', display:'grid', placeItems:'center', fontSize:14, lineHeight:'28px' }}>✓</div>
                    <div>
                      <div style={{ fontWeight:600, marginBottom:4 }}>{c.t}</div>
                      <div style={{ color:'#475569', fontSize:14 }}>{c.d}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:20, display:'flex', gap:16, flexWrap:'wrap' }}>
                <button onClick={openGuide} className="vh-btn vh-btn-primary vh-btn-lg">{t('GetStarted')}</button>
                <Link href="/analysis" className="vh-btn vh-btn-outline vh-btn-lg" style={{ textDecoration:'none' }}>{t('Analysis')}</Link>
              </div>
            </div>
            <div>
              <div style={{ borderRadius:16, padding:16, background:'linear-gradient(135deg, #eef2ff, #ecfeff)' , border:'1px solid #e5e7eb' }}>
                <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
                  <span style={{ padding:'4px 10px', borderRadius:9999, background:'#fff', border:'1px solid #c7d2fe', color:'#3730a3', fontSize:12 }}>{t('HomeAIStat1')}</span>
                  <span style={{ padding:'4px 10px', borderRadius:9999, background:'#fff', border:'1px solid #a5f3fc', color:'#0e7490', fontSize:12 }}>{t('HomeAIStat2')}</span>
                  <span style={{ padding:'4px 10px', borderRadius:9999, background:'#fff', border:'1px solid #bbf7d0', color:'#166534', fontSize:12 }}>{t('HomeAIStat3')}</span>
                </div>
                <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16 }}>
                  <div style={{ fontWeight:700, fontSize:18, marginBottom:8 }}>{t('HomeAISampleTitle')}</div>
                  <div style={{ marginBottom:8 }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>Summary</div>
                    <div style={{ color:'#0f172a', fontSize:14 }}>{t('HomeAISampleSummary')}</div>
                  </div>
                  <div style={{ marginBottom:8 }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>Potential Risks</div>
                    <div style={{ color:'#0f172a', fontSize:14 }}>{t('HomeAISampleRisks')}</div>
                  </div>
                  <div>
                    <div style={{ fontWeight:600, marginBottom:4 }}>Advice</div>
                    <div style={{ color:'#0f172a', fontSize:14 }}>{t('HomeAISampleAdvice')}</div>
                  </div>
                </div>
                <div style={{ marginTop:8, fontSize:12, color:'#64748b' }}>{t('HomeAIFineprint')}</div>
              </div>
            </div>
          </div>
        </div>
      </section>
      {/* 4. Medical endorsement (removed per request) */}
      {/* 5. Community stories */}
      <section style={{ padding: '64px 24px' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <h2 style={{ fontSize: 32, marginBottom: 16 }}>{t('CommunityHomeTitle')}</h2>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, minmax(0,1fr))', gap:12 }}>
            {[t('Story1'), t('Story2'), t('Story3')].map((s,i)=> (
              <div key={i} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:16, padding:16 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                  <div style={{ width:32, height:32, borderRadius:9999, background: i%2? '#000':'#fff', border:'1px solid #e5e7eb' }} />
                  <div style={{ fontWeight:600 }}>User</div>
                </div>
                <div style={{ color:'#0f172a', marginBottom:8 }}>{s}</div>
                <div style={{ height:56, borderRadius:8, background:'repeating-linear-gradient(90deg,#e2e8f0, #e2e8f0 4px, #f8fafc 4px, #f8fafc 8px)' }} />
              </div>
            ))}
          </div>
        </div>
      </section>
      {/* 6. Footer */}
      <section style={{ padding: '64px 24px', background:'rgba(255,255,255,0.6)', borderTop:'1px solid #e5e7eb' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display:'grid', gridTemplateColumns:'repeat(3, minmax(0,1fr))', gap:16 }}>
          <div>
            <div style={{ fontWeight:600, marginBottom:6 }}>{t('FooterPrivacy')}</div>
            <div style={{ color:'#475569', fontSize:14 }}>{t('PrivacyText')}</div>
          </div>
          <div>
            <div style={{ fontWeight:600, marginBottom:6 }}>{t('FooterTeam')}</div>
            <div style={{ color:'#475569', fontSize:14 }}>{t('TeamText')}</div>
          </div>
          <div>
            <div style={{ fontWeight:600, marginBottom:6 }}>{t('FooterFAQ')}</div>
            <div style={{ color:'#475569', fontSize:14 }}>{t('FAQText')}</div>
          </div>
        </div>
      </section>

      {/* Guide Modal */}
      {guide && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'grid', placeItems:'center', zIndex:50 }}>
          <div style={{ width: 520, maxWidth:'90vw', background:'#fff', borderRadius:16, boxShadow:'0 10px 40px rgba(0,0,0,0.2)', padding:20 }}>
            <h3 style={{ margin:'6px 0 8px', fontSize:22 }}>{t('GuideTitle')}</h3>
            <p style={{ color:'#475569', margin:'0 0 12px' }}>{t('GuideDesc')}</p>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={()=>setGuide(false)} className="vh-btn vh-btn-outline">{t('GuideCancel')}</button>
              <button onClick={()=>fileInputRef.current?.click()} className="vh-btn vh-btn-primary">{t('GuideUpload')}</button>
            </div>
            {busy && (
              <div style={{ marginTop:12, display:'flex', alignItems:'center', gap:8, color:'#64748b' }}>
                <div className="vh-spin" />
                <div>Uploading {progress.done} / {progress.total} …</div>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="audio/*" multiple style={{ display:'none' }} onChange={onFiles} />
          </div>
          <style>{`.vh-spin{width:18px;height:18px;border:3px solid #cbd5e1;border-top-color:#2563eb;border-radius:9999px;animation:vh-rot 0.8s linear infinite}@keyframes vh-rot{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
    </div>
  );
}
