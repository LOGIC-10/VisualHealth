"use client";
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';
import WaveSurfer from 'wavesurfer.js';
const VIZ_BASE = process.env.NEXT_PUBLIC_API_VIZ || 'http://localhost:4006';

export default function AnalyzePage() {
  const { t } = useI18n();
  const containerRef = useRef(null);
  const [ws, setWs] = useState(null);
  const [features, setFeatures] = useState(null);
  const [fileObj, setFileObj] = useState(null);
  const [token, setToken] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState(null);

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    if (t) setToken(t);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#94a3b8',
      progressColor: '#111827',
      height: 120
    });
    setWs(wavesurfer);
    return () => wavesurfer.destroy();
  }, []);

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file || !ws) return;
    setFileObj(file);
    const arrayBuffer = await file.arrayBuffer();
    ws.loadBlob(file);
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const channel = audioBuf.getChannelData(0);
    const targetSR = 8000;
    const ratio = Math.max(1, Math.floor(audioBuf.sampleRate / targetSR));
    const ds = new Float32Array(Math.ceil(channel.length / ratio));
    for (let i = 0; i < ds.length; i++) ds[i] = channel[i * ratio] || 0;
    const resp = await fetch((process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004') + '/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sampleRate: Math.round(audioBuf.sampleRate / ratio), pcm: Array.from(ds) })
    });
    const json = await resp.json();
    setFeatures(json);

    // If logged in, persist upload + record automatically
    setSavedId(null);
    if (token) {
      try {
        setSaving(true);
        const fd = new FormData();
        fd.append('file', file);
        const up = await fetch((process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003') + '/upload', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd
        });
        const meta = await up.json();
        if (!meta?.id) throw new Error('upload failed');
        const rec = await fetch((process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004') + '/records', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ mediaId: meta.id, filename: meta.filename, mimetype: meta.mimetype, size: meta.size, features: json })
        });
        const saved = await rec.json();
        if (saved?.id) setSavedId(saved.id);

        // Precompute advanced & spectrogram and patch record (cache)
        try {
          const payload = { sampleRate: Math.round(audioBuf.sampleRate / ratio), pcm: Array.from(ds) };
          const [advResp, specResp] = await Promise.all([
            fetch(VIZ_BASE + '/pcg_advanced', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) }),
            fetch(VIZ_BASE + '/spectrogram_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ...payload, maxFreq:2000, width:1200, height:320 }) })
          ]);
          let specId = null; let adv = null;
          if (specResp.ok) {
            const imgBlob = await specResp.blob();
            const fdu = new FormData();
            fdu.append('file', new File([imgBlob], 'spectrogram.png', { type:'image/png' }));
            const up2 = await fetch((process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003') + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fdu });
            const j2 = await up2.json();
            if (j2?.id) specId = j2.id;
          }
          if (advResp.ok) adv = await advResp.json();
          if (saved?.id && (adv || specId)) {
            await fetch((process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004') + `/records/${saved.id}`, {
              method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ adv: adv || null, specMediaId: specId || null })
            });
          }
        } catch {}
      } catch (err) {
        console.warn('persist failed', err);
      } finally {
        setSaving(false);
      }
    }
  }

  // Upload removed per design (no encrypted saving)

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('NewAnalysis')}</h1>
      <input type="file" accept="audio/*" onChange={handleFile} />
      <div ref={containerRef} style={{ marginTop: 16 }} />
      {/* Removed Save Encrypted Copy */}
      {features && (
        <div style={{ marginTop: 16, background: '#f8fafc', padding: 16, borderRadius: 12 }}>
          <h3>{t('Features')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 }}>
            <div><b>{t('Duration')}:</b> {features.durationSec?.toFixed?.(2)}</div>
            <div><b>{t('SampleRate')}:</b> {features.sampleRate}</div>
            <div><b>{t('RMS')}:</b> {features.rms?.toFixed?.(4)}</div>
            <div><b>{t('ZCR')}:</b> {Math.round(features.zcrPerSec)}</div>
            <div><b>{t('PeakRate')}:</b> {features.peakRatePerSec?.toFixed?.(2)}</div>
          </div>
          {token && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#475569' }}>
              {saving && 'Saving to history...'}
              {!saving && savedId && (
                <a href={`/analysis/${savedId}`} style={{ color:'#2563eb', textDecoration:'none' }}>Saved to history ✓ View record</a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
