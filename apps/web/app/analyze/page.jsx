"use client";
import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';

export default function AnalyzePage() {
  const containerRef = useRef(null);
  const [ws, setWs] = useState(null);
  const [features, setFeatures] = useState(null);
  const [fileObj, setFileObj] = useState(null);
  const [token, setToken] = useState(null);

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
  }

  async function upload() {
    if (!fileObj) return alert('Choose a file first');
    if (!token) return alert('Please login');
    const fd = new FormData();
    fd.append('file', fileObj);
    const resp = await fetch((process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003') + '/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd
    });
    const json = await resp.json();
    if (json.id) alert('Uploaded and encrypted ✓'); else alert('Upload failed');
  }

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>Analyze Heart Sound</h1>
      <input type="file" accept="audio/*" onChange={handleFile} />
      <div ref={containerRef} style={{ marginTop: 16 }} />
      <div style={{ marginTop: 8 }}>
        <button onClick={upload} style={{ padding: '8px 12px', borderRadius: 8, background: '#111', color: '#fff' }}>Save Encrypted Copy</button>
      </div>
      {features && (
        <div style={{ marginTop: 16, background: '#f8fafc', padding: 16, borderRadius: 12 }}>
          <h3>Features</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 12 }}>
            <div><b>Duration (s):</b> {features.durationSec?.toFixed?.(2)}</div>
            <div><b>Sample Rate:</b> {features.sampleRate}</div>
            <div><b>RMS:</b> {features.rms?.toFixed?.(4)}</div>
            <div><b>ZCR (/s):</b> {Math.round(features.zcrPerSec)}</div>
            <div><b>Peak Rate (/s):</b> {features.peakRatePerSec?.toFixed?.(2)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

