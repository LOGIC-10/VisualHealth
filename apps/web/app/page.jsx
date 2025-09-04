"use client";
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../components/i18n';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';

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

function Demo(){
  const waveRef = useRef(null); const specRef = useRef(null); const audioRef = useRef(null); const wsRef = useRef(null); const urlRef = useRef('');
  useEffect(()=>{
    const blob = makeHeartbeatWav(6, 8000);
    const url = URL.createObjectURL(blob); urlRef.current = url;
    if (audioRef.current){ audioRef.current.src = url; audioRef.current.load(); }
    const ws = WaveSurfer.create({ container: waveRef.current, media: audioRef.current, height: 96, minPxPerSec: 120, waveColor:'#94a3b8', progressColor:'#111827', normalize:true });
    ws.registerPlugin(Spectrogram.create({ container: specRef.current, height: 160, labels:false, frequencyMin:0, frequencyMax:2000 }));
    wsRef.current = ws;
    return ()=>{ try{ws.destroy();}catch{} URL.revokeObjectURL(urlRef.current); };
  },[]);
  return (
    <div>
      <div ref={waveRef} style={{ border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', background:'#fff' }} />
      <div ref={specRef} style={{ marginTop:8, border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', background:'#fff' }} />
      <audio ref={audioRef} controls style={{ marginTop:8, width:'100%' }} />
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
  const ANALYSIS_BASE = process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004';
  const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';
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
          <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
            <button onClick={openGuide} style={{ padding: '12px 16px', background: '#111', color: '#fff', borderRadius: 12, textDecoration: 'none', cursor:'pointer' }}>{t('GetStarted')}</button>
            <a href="/community" style={{ padding: '12px 16px', background: '#e5e7eb', color: '#111', borderRadius: 12, textDecoration: 'none' }}>{t('ExploreCommunity')}</a>
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
              <button onClick={()=>setGuide(false)} style={{ padding:'8px 12px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff', cursor:'pointer' }}>{t('GuideCancel')}</button>
              <button onClick={()=>fileInputRef.current?.click()} style={{ padding:'8px 12px', borderRadius:8, background:'#111', color:'#fff', cursor:'pointer' }}>{t('GuideUpload')}</button>
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
