"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../../components/i18n';
import { renderMarkdown } from '../../../components/markdown';

import WaveSurfer from 'wavesurfer.js';

const VIZ_BASE = process.env.NEXT_PUBLIC_API_VIZ || 'http://localhost:4006';
const AUTH_BASE = process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001';

const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';
const ANALYSIS_BASE = process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004';
const LLM_BASE = process.env.NEXT_PUBLIC_API_LLM || 'http://localhost:4007';

export default function AnalysisDetail({ params }) {
  const { t, lang } = useI18n();
  const { id } = params;
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
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
  const pinchRef = useRef({ active:false, id1:null, id2:null, startDist:0, startPx:0 });
  const playheadRef = useRef(null);
  const playheadTimeRef = useRef(null);
  const selectionRef = useRef(null);
  const selectLabelRef = useRef(null);
  const [viewRange, setViewRange] = useState({ start: 0, end: 0 });
  const selectingRef = useRef(false);
  const selectStartXRef = useRef(0);
  const selectStartSecRef = useRef(0);
  const [specUrl, setSpecUrl] = useState(null);
  const [adv, setAdv] = useState(null);
  const [loading, setLoading] = useState({ decode: false, extra: false, adv: false, spec: false });
  const [progress, setProgress] = useState(0);
  const [audioError, setAudioError] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMetrics, setAiMetrics] = useState(null);
  const [aiText, setAiText] = useState('');
  const [aiErr, setAiErr] = useState('');
  const [aiSubmitted, setAiSubmitted] = useState(false);
  const [pcmPayload, setPcmPayload] = useState(null);
  // Gain control
  const [gainOpen, setGainOpen] = useState(false);
  const [gainOn, setGainOn] = useState(false);
  const [gainVal, setGainVal] = useState(1);
  const audioCtxRef = useRef(null);
  const mediaSrcRef = useRef(null);
  const gainNodeRef = useRef(null);
  const gainReadyRef = useRef(false);
  const compNodeRef = useRef(null);
  const prevVolRef = useRef(1);
  const [waveFocused, setWaveFocused] = useState(false);
  const [navOffset, setNavOffset] = useState(96);
  useEffect(() => {
    try {
      const nav = document.querySelector('nav');
      if (nav) {
        const h = Math.ceil(nav.getBoundingClientRect().height);
        setNavOffset(h + 16);
      }
    } catch {}
  }, []);

  // Chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMsgs, setChatMsgs] = useState([]); // [{role:'user'|'assistant', content:string}]
  const [chatBusy, setChatBusy] = useState(false);
  const [chatErr, setChatErr] = useState('');
  const chatAbortRef = useRef(null);
  const assistantAccumRef = useRef('');
  const chatScrollRef = useRef(null);

  // Load persisted chat history for this analysis record
  useEffect(() => {
    if (!token || !id) return;
    (async () => {
      try {
        const r = await fetch(ANALYSIS_BASE + `/records/${id}/chat`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const rows = await r.json();
        if (Array.isArray(rows)) setChatMsgs(rows.map(m => ({ role: m.role, content: m.content })));
      } catch {}
    })();
  }, [token, id]);

  // Also refresh chat history whenever the chat panel is opened
  useEffect(() => {
    if (!chatOpen || !token || !id) return;
    (async () => {
      try {
        const r = await fetch(ANALYSIS_BASE + `/records/${id}/chat`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const rows = await r.json();
        if (Array.isArray(rows)) setChatMsgs(rows.map(m => ({ role: m.role, content: m.content })));
      } catch {}
    })();
  }, [chatOpen, token, id]);

  function buildChatContext(){
    const ctx = [];
    if (meta?.ai) {
      const ttxt = (meta.ai.texts && meta.ai.texts[lang]) || meta.ai.text || '';
      if (ttxt) ctx.push(`Analysis (Markdown):\n\n${ttxt}`);
      try { if (meta.ai.metrics) ctx.push(`Metrics: ${JSON.stringify(meta.ai.metrics)}`); } catch {}
    }
    return ctx.join('\n\n');
  }

  async function sendChat(userText){
    if (!userText || chatBusy) return;
    setChatBusy(true); setChatErr('');
    const sys = lang==='zh'
      ? '你是一名心血管科医生助手。基于提供的分析上下文与用户问题，给出可靠、谨慎的回答。'
      : 'You are a cardiology assistant. Use the provided analysis context and user questions to respond clearly and cautiously.';
    const ctxText = buildChatContext();
    const messages = [
      { role:'system', content: sys },
      { role:'user', content: (lang==='zh' ? '上下文（仅供参考）：\n' : 'Context (for reference):\n') + ctxText },
      ...chatMsgs,
      { role:'user', content: userText }
    ];
    // Persist user message immediately (best-effort)
    try { await fetch(ANALYSIS_BASE + `/records/${id}/chat`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ role:'user', content: userText }) }); } catch {}
    setChatMsgs(cur => cur.concat([{ role:'user', content:userText }, { role:'assistant', content:'' }]));
    // Setup abort controller and accum buffer for streaming
    assistantAccumRef.current = '';
    chatAbortRef.current = new AbortController();
    try {
      // Try streaming first (user explicitly wants real-time output)
      const resp = await fetch(LLM_BASE + '/chat_sse', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Accept':'text/event-stream' },
        body: JSON.stringify({ messages, temperature: 0.2 }),
        signal: chatAbortRef.current.signal
      });
      if (!resp.ok || !resp.body) {
        // Fallback to non-streaming endpoint
        const resp2 = await fetch(LLM_BASE + '/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ messages, temperature: 0.2 }), signal: chatAbortRef.current.signal });
        const j2 = await resp2.json().catch(()=>({}));
        if (!resp2.ok || j2?.error) throw new Error(j2?.error || 'chat failed');
        const text = j2?.text || '';
        setChatMsgs(cur => { const c = cur.slice(); const last=c[c.length-1]; if (last && last.role==='assistant') last.content = text; return c; });
        // Persist assistant reply
        try { if (text && text.trim()) await fetch(ANALYSIS_BASE + `/records/${id}/chat`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ role:'assistant', content: text }) }); } catch {}
        return;
      }
      const reader = resp.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      let assistantAccum = '';
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx + 2);
          if (!raw) continue; const line = raw.split('\n').find(l=> l.startsWith('data:')) || raw;
          const jsonStr = line.replace(/^data:\s*/, '');
          try {
            const evt = JSON.parse(jsonStr);
            if (evt?.delta) {
              const piece = String(evt.delta);
              setChatMsgs(cur => {
                const c = cur.slice();
                const last = c[c.length - 1];
                if (last && last.role === 'assistant') {
                  const prev = last.content || '';
                  // Robust merge: allow for providers that send cumulative text or overlapping chunks
                  let k = Math.min(prev.length, piece.length);
                  while (k > 0 && !prev.endsWith(piece.slice(0, k))) k--;
                  const toAppend = piece.slice(k);
                  if (toAppend) { assistantAccum += toAppend; assistantAccumRef.current += toAppend; last.content = prev + toAppend; }
                }
                return c;
              });
            }
            if (evt?.error) throw new Error(evt.error);
          } catch {}
        }
      }
      // persist streamed reply
      try { if (assistantAccum && assistantAccum.trim()) await fetch(ANALYSIS_BASE + `/records/${id}/chat`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ role:'assistant', content: assistantAccum }) }); } catch {}
    } catch(e){
      const isAbort = e?.name === 'AbortError' || /aborted|AbortError/i.test(e?.message || '');
      if (isAbort) {
        // On cancel: persist any partial text; if none, remove empty assistant bubble
        try {
          const partial = assistantAccumRef.current || '';
          if (partial.trim()) {
            await fetch(ANALYSIS_BASE + `/records/${id}/chat`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ role:'assistant', content: partial }) });
          } else {
            setChatMsgs(cur => {
              const c = cur.slice();
              const last = c[c.length-1];
              if (last && last.role==='assistant' && !last.content) c.pop();
              return c;
            });
          }
        } catch {}
      } else {
        const msg = e?.message || 'chat failed';
        setChatErr(msg);
        // Fill last assistant bubble with error text if empty
        setChatMsgs(cur => {
          const c = cur.slice();
          const last = c[c.length-1];
          if (last && last.role==='assistant' && !last.content) last.content = msg;
          return c;
        });
      }
    } finally {
      setChatBusy(false);
      chatAbortRef.current = null;
    }
  }

  function cancelChat(){
    try { chatAbortRef.current?.abort(); } catch {}
  }

  // Auto-scroll to the latest message/content
  useEffect(() => {
    const el = chatScrollRef.current; if (!el) return;
    // smooth but snappy; always scroll to bottom on updates
    requestAnimationFrame(() => { try { el.scrollTop = el.scrollHeight; } catch {} });
  }, [chatMsgs, chatBusy, chatOpen]);

  useEffect(() => { try { setToken(localStorage.getItem('vh_token')); } catch {} }, []);

  // Load current user once and subscribe to profile changes; seed from cache to avoid flicker
  useEffect(() => {
    let tkn = null; try { tkn = localStorage.getItem('vh_token'); } catch {}
    if (tkn) {
      try { const cached = window.__vh_user; if (cached && cached.id) setMe(cached); } catch {}
      fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${tkn}` } })
        .then(r=> r.ok ? r.json() : Promise.reject())
        .then(u=>{ if (u && !u.error) setMe(u); })
        .catch(()=>{});
    }
    function onUserChange(ev){ const u = ev?.detail; if (u && u.id) setMe(u); }
    window.addEventListener('vh_user_change', onUserChange);
    return () => window.removeEventListener('vh_user_change', onUserChange);
  }, []);

  // Persisted pending flag to avoid repeated submissions across reloads
  useEffect(() => {
    if (!id) return;
    try {
      const key = `vh_ai_pending_${id}_${lang}`;
      const v = localStorage.getItem(key);
      setAiSubmitted(v === '1');
    } catch {}
  }, [id, lang]);

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
      if (rec.ai) {
        try {
          setAiMetrics(rec.ai.metrics || null);
          const initialText = (rec.ai.texts && rec.ai.texts[lang]) || rec.ai.text || '';
          setAiText(initialText);
        } catch {}
      }
      if (rec.ai_generated_at) {
        try { setAiMetrics(m=> ({ ...(m||{}), generated_at: rec.ai_generated_at })); } catch {}
      }
      if (rec.spec_media_id) {
        try {
          const fr = await fetch(MEDIA_BASE + `/file/${rec.spec_media_id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (fr.ok) { const b = await fr.blob(); setSpecUrl(URL.createObjectURL(b)); }
        } catch {}
      }
    })();
  }, [id, token]);

  // Update AI text when language changes or meta updates
  useEffect(() => {
    if (!meta?.ai) return;
    const next = (meta.ai.texts && meta.ai.texts[lang]) || meta.ai.text || '';
    setAiText(next);
  }, [lang, meta]);

  // Poll for AI result when submitted, so UI updates automatically without page refresh
  useEffect(() => {
    if (!token || !id) return;
    if (aiText) return; // already have text; no need to poll
    const pendingOnServer = !!meta?.ai?.pending && !!meta.ai.pending[lang];
    if (!(aiSubmitted || pendingOnServer)) return;
    let cancelled = false;
    let tries = 0;
    const maxTries = 60; // ~3 minutes at 3s interval
    const iv = setInterval(async () => {
      if (cancelled) return;
      tries++;
      try {
        const r = await fetch(ANALYSIS_BASE + `/records/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const rec = await r.json();
        setMeta(rec);
        if (rec?.ai) {
          const txt = (rec.ai.texts && rec.ai.texts[lang]) || rec.ai.text || '';
          if (txt && txt.length > 0) {
            setAiText(txt);
            try { setAiMetrics(rec.ai.metrics || null); } catch {}
            try { localStorage.removeItem(`vh_ai_pending_${id}_${lang}`); } catch {}
            clearInterval(iv);
          }
        }
      } catch {}
      if (tries >= maxTries) clearInterval(iv);
    }, 3000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [aiSubmitted, aiText, token, id, lang, meta]);

  // Load audio blob URL only (render handled by WaveSurfer)
  useEffect(() => {
    if (!token || !meta) return;
    (async () => {
      setAudioError(null);
      let blob = null;
      // Prefer short-lived signed URL to avoid any Authorization/CORS edge cases
      try {
        const surl = await fetch(MEDIA_BASE + `/file_url/${meta.media_id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (surl.ok) {
          const j = await surl.json();
          if (j?.url) {
            const fr = await fetch(j.url);
            if (fr.ok) blob = await fr.blob();
          }
        }
      } catch {}
      if (!blob) {
        // Fallback to direct authorized fetch
        const r = await fetch(MEDIA_BASE + `/file/${meta.media_id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) blob = await r.blob();
      }
      if (!blob) { setAudioError('无法加载音频文件（可能的权限或密钥问题）'); return; }
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      // Keep existing WebAudio graph; no rewiring needed on src change
      // compute extra features once (off-UI path)
      try {
        // Only show progress for modules that are not yet stored (adv/spec)
        const needAdv = !(meta && meta.adv);
        const needSpec = !(meta && meta.spec_media_id);
        const steps = (needAdv ? 1 : 0) + (needSpec ? 1 : 0);
        const per = steps > 0 ? (1 / steps) : 0;

        // Initialize loading flags: do not surface decode/extra in progress bar
        setLoading(s=>({ ...s, decode:false, extra:false, adv:needAdv, spec:needSpec }));
        setProgress(0);
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
        setPcmPayload(payload);
        // run in parallel
        const featuresP = (async ()=>{
          const resp = await fetch(VIZ_BASE + '/features_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
          if (resp.ok) setExtra(await resp.json());
          setLoading(s=>({ ...s, extra:false }));
        })();
        const advP = needAdv ? (async ()=>{
          const resp = await fetch(VIZ_BASE + '/pcg_advanced', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
          if (resp.ok) setAdv(await resp.json());
          setLoading(s=>({ ...s, adv:false })); if (per>0) setProgress(p=>p+per);
        })() : Promise.resolve();
        const width = Math.max(800, Math.min(1400, Math.floor((typeof window!=='undefined'? window.innerWidth:1200) - 80)));
        const specP = needSpec ? (async ()=>{
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
          setLoading(s=>({ ...s, spec:false })); if (per>0) setProgress(p=>p+per);
        })() : Promise.resolve();
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

  // If AI exists but missing current language text, silently schedule background generation
  useEffect(() => {
    if (!token || !meta || !pcmPayload) return;
    const hasTexts = !!meta?.ai?.texts;
    const hasLang = hasTexts && (meta.ai.texts[lang] && meta.ai.texts[lang].length > 0);
    if (meta?.ai && !hasLang) {
      (async ()=>{
        try {
          // Mark as submitted to prevent repeated manual clicks
          setAiSubmitted(true);
          try { localStorage.setItem(`vh_ai_pending_${id}_${lang}`, '1'); } catch {}
          await fetch(ANALYSIS_BASE + `/records/${id}/ai_start`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ ...pcmPayload, lang }) });
        } catch {}
      })();
    }
  }, [lang, meta, pcmPayload, token, id]);
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
      progressColor: '#94a3b8',
      cursorWidth: 0,
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
      try {
        ws.drawer.updateSize();
        ws.drawBuffer();
        ws.drawer.progressWidth = ws.drawer.width;
      } catch {}
      requestAnimationFrame(() => centerOnPlayhead(minPx));
    });
    wsRef.current = ws;
    return () => {
      try { ws.destroy(); } catch {}
    };
  }, [audioUrl]);

  async function setupGainPipeline(){
    const el = audioRef.current; if (!el) return;
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      audioCtxRef.current = new AC();
    }
    const ctx = audioCtxRef.current;
    try { await ctx.resume?.(); } catch {}
    // Remember current element volume, and avoid toggling the 'muted' UI state
    try { prevVolRef.current = typeof el.volume === 'number' ? el.volume : 1; } catch { prevVolRef.current = 1; }
    if (!mediaSrcRef.current) {
      mediaSrcRef.current = ctx.createMediaElementSource(el);
    }
    if (!gainNodeRef.current) {
      gainNodeRef.current = ctx.createGain();
    }
    if (!compNodeRef.current) {
      const c = ctx.createDynamicsCompressor?.();
      if (c) {
        try {
          c.threshold.setValueAtTime(-10, ctx.currentTime);
          c.knee.setValueAtTime(12, ctx.currentTime);
          c.ratio.setValueAtTime(4, ctx.currentTime);
          c.attack.setValueAtTime(0.003, ctx.currentTime);
          c.release.setValueAtTime(0.25, ctx.currentTime);
        } catch {}
        compNodeRef.current = c;
      }
    }
    try { mediaSrcRef.current.disconnect(); } catch {}
    try { gainNodeRef.current.disconnect(); } catch {}
    if (compNodeRef.current) {
      mediaSrcRef.current.connect(gainNodeRef.current);
      gainNodeRef.current.connect(compNodeRef.current);
      compNodeRef.current.connect(ctx.destination);
    } else {
      mediaSrcRef.current.connect(gainNodeRef.current);
      gainNodeRef.current.connect(ctx.destination);
    }
    // Prepare gain at tiny value; actual ramp handled by crossfade helpers
    try { gainNodeRef.current.gain.setValueAtTime(0.0001, ctx.currentTime); } catch {}
    gainReadyRef.current = true;
  }

  function disableGainPipeline(){
    // Keep pipeline connected; normalize to 1x so playback continues identically
    const ctx = audioCtxRef.current; const g = gainNodeRef.current;
    if (ctx && g) {
      try { g.gain.setTargetAtTime(1.0, ctx.currentTime, 0.02); } catch { try { g.gain.value = 1.0; } catch {} }
    }
  }

  function applyEffectiveGain(initial=false){
    const ctx = audioCtxRef.current; const g = gainNodeRef.current; if (!ctx || !g) return;
    // Map UI range [1,5] to stronger gain, but keep 1.0 as true 1x on enable
    const BASE_MULT = 20; // >1 values get boosted
    const eff = (initial || gainVal <= 1.0001) ? 1 : Math.max(1, BASE_MULT * gainVal);
    try {
      if (initial) {
        // quick ramp to avoid click and preserve continuity
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(0.0001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(Math.max(1, eff), ctx.currentTime + 0.05);
      } else {
        g.gain.setTargetAtTime(eff, ctx.currentTime, 0.02);
      }
    } catch { try { g.gain.value = eff; } catch {} }
  }

  // Smooth helpers removed to simplify and avoid side-effects

  useEffect(() => {
    if (!audioRef.current) return;
    if (gainOn) {
      if (!gainReadyRef.current) {
        setupGainPipeline().then(() => applyEffectiveGain(true));
      } else {
        applyEffectiveGain();
      }
    } else {
      // Turning off keeps pipeline at 1x; playback continues
      disableGainPipeline();
    }
  }, [gainVal, gainOn]);

  useEffect(() => () => { disableGainPipeline(); }, []);

  function centerOnPlayhead(nextPx=pxPerSec){
    const wrapper = waveWrapRef.current; const a = audioRef.current; if (!wrapper || !a) return;
    const rect = wrapper.getBoundingClientRect();
    const pps = nextPx;
    const totalW = pps * (duration || 0);
    const playX = a.currentTime * pps;
    const half = rect.width / 2;
    let scroll = wrapper.scrollLeft;
    if (playX <= half || totalW <= rect.width) {
      scroll = 0;
    } else if (playX >= totalW - half) {
      scroll = Math.max(0, totalW - rect.width);
    } else {
      scroll = playX - half;
    }
    wrapper.scrollLeft = scroll;
    const px = Math.max(0, Math.min(rect.width - 2, playX - scroll));
    if (playheadRef.current) playheadRef.current.style.left = px + 'px';
    if (playheadTimeRef.current) playheadTimeRef.current.style.left = px + 'px';
    refreshOverlay(pps);
  }

  function zoomAt(timeSec, nextPx){
    const wrapper = waveWrapRef.current; if (!wrapper || !wsRef.current) return;
    const rect = wrapper.getBoundingClientRect();
    wsRef.current.zoom(nextPx);
    try {
      wsRef.current.drawer.updateSize();
      wsRef.current.drawBuffer();
      wsRef.current.drawer.progressWidth = wsRef.current.drawer.width;
    } catch {}
    const maxScroll = Math.max(0, nextPx * (duration || 0) - rect.width);
    const target = timeSec * nextPx - rect.width / 2;
    wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, target));
    centerOnPlayhead(nextPx);
  }

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
    if (isZoom) {
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const next = Math.max(minPx, Math.min(5000, currentPx * (1 / factor)));
      const a = audioRef.current;
      const pivotSec = a ? a.currentTime : (wrapper.scrollLeft + rect.width / 2) / currentPx;
      setPxPerSec(next);
      requestAnimationFrame(() => zoomAt(pivotSec, next));
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

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const handle = () => centerOnPlayhead();
    a.addEventListener('play', handle);
    a.addEventListener('seeked', handle);
    return () => { a.removeEventListener('play', handle); a.removeEventListener('seeked', handle); };
  }, [pxPerSec, duration]);

  const downXRef = useRef(0);
  const movedRef = useRef(false);
  function onMouseDown(e){
    const wrapper = waveWrapRef.current; if (!wrapper) return;
    wrapper.focus();
    if (e.shiftKey) {
      selectingRef.current = true;
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      selectStartXRef.current = x;
      selectStartSecRef.current = (wrapper.scrollLeft + x) / pxPerSec;
      if (selectionRef.current) {
        selectionRef.current.style.display = 'block';
        selectionRef.current.style.left = x + 'px';
        selectionRef.current.style.width = '0px';
      }
      if (selectLabelRef.current) {
        selectLabelRef.current.style.display = 'block';
        selectLabelRef.current.style.left = x + 'px';
      }
      return;
    }
    isDraggingRef.current = true; downXRef.current = lastXRef.current = e.clientX; movedRef.current = false;
  }
  function onMouseMove(e){
    const wrapper = waveWrapRef.current; if (!wrapper) return;
    if (selectingRef.current) {
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const startX = selectStartXRef.current;
      const left = Math.min(startX, x);
      const width = Math.abs(x - startX);
      if (selectionRef.current) {
        selectionRef.current.style.left = left + 'px';
        selectionRef.current.style.width = width + 'px';
      }
      const startSec = (wrapper.scrollLeft + left) / pxPerSec;
      const endSec = (wrapper.scrollLeft + left + width) / pxPerSec;
      const dur = Math.max(0, endSec - startSec);
      if (selectLabelRef.current) {
        const decimals = dur < 1 ? 3 : dur < 10 ? 2 : 1;
        selectLabelRef.current.textContent = dur.toFixed(decimals) + 's';
        selectLabelRef.current.style.left = left + 'px';
      }
      return;
    }
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastXRef.current; lastXRef.current = e.clientX;
    const rect = wrapper.getBoundingClientRect();
    const pps = pxPerSec;
    const maxScroll = Math.max(0, pps * duration - rect.width);
    if (Math.abs(e.clientX - downXRef.current) > 3) movedRef.current = true;
    wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, wrapper.scrollLeft - dx)); // drag to pan with bounds
  }
  function onMouseUp(e){
    const wrapper = waveWrapRef.current; if (!wrapper) { isDraggingRef.current = false; selectingRef.current = false; return; }
    if (selectingRef.current) {
      const rect = wrapper.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const startX = selectStartXRef.current;
      const left = Math.min(startX, x);
      const width = Math.abs(x - startX);
      selectingRef.current = false;
      if (selectionRef.current) selectionRef.current.style.display = 'none';
      if (selectLabelRef.current) selectLabelRef.current.style.display = 'none';
      if (width > 3) {
        const startSec = (wrapper.scrollLeft + left) / pxPerSec;
        const endSec = (wrapper.scrollLeft + left + width) / pxPerSec;
        const selDur = Math.max(0.001, endSec - startSec);
        const rectW = rect.width;
        const minPx = duration > 0 ? (rectW / duration) : 10;
        const next = Math.max(minPx, Math.min(5000, rectW / selDur));
        const centerSec = startSec + selDur / 2;
        if (audioRef.current) audioRef.current.currentTime = centerSec;
        setPxPerSec(next);
        requestAnimationFrame(() => zoomAt(centerSec, next));
      }
      return;
    }
    isDraggingRef.current = false;
  }

  // Click-to-seek handler
  function onClick(e){
    const wrapper = waveWrapRef.current; if (!wrapper || movedRef.current || selectingRef.current) return;
    if (!duration) return;
    const rect = wrapper.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const sec = Math.max(0, Math.min(duration, (wrapper.scrollLeft + x) / pxPerSec));
    if (audioRef.current) audioRef.current.currentTime = sec;
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
        pinchRef.current.startPx = pxPerSec;
      } else {
        const scale = dist / pinchRef.current.startDist;
        const minPx = duration > 0 ? (rect.width / duration) : 10;
        const next = Math.max(minPx, Math.min(5000, pinchRef.current.startPx * scale));
        const a = audioRef.current;
        const pivotSec = a ? a.currentTime : (waveWrapRef.current.scrollLeft + rect.width / 2) / pxPerSec;
        setPxPerSec(next);
        requestAnimationFrame(() => zoomAt(pivotSec, next));
      }
    }
  }
  function onTouchEnd(){ pinchRef.current.startDist = 0; }

  // Update playhead position and absolute time range label
  function refreshOverlay(pps = pxPerSec){
    const wrap = waveWrapRef.current; if (!wrap) return;
    const start = (wrap.scrollLeft || 0) / pps;
    const end = Math.min(duration || 0, start + (wrap.clientWidth || 0) / pps);
    setViewRange({ start, end });
    const a = audioRef.current;
    const pt = playheadTimeRef.current;
    if (a) {
      const playSec = Math.max(0, Math.min(duration || 0, a.currentTime));
      const x = playSec * pps - (wrap.scrollLeft || 0);
      if (playheadRef.current) playheadRef.current.style.left = x + 'px';
      if (pt) { pt.textContent = playSec.toFixed(2) + 's'; pt.style.left = x + 'px'; }
    }
  }

  // Track visible time range for header label
  useEffect(() => {
    const wrap = waveWrapRef.current; if (!wrap) return;
    refreshOverlay();
    const handle = () => refreshOverlay();
    wrap.addEventListener('scroll', handle);
    return () => wrap.removeEventListener('scroll', handle);
  }, [pxPerSec, duration]);

  // Keep playhead centered during playback
  useEffect(() => {
    let raf = 0; const a = audioRef.current; const wrap = waveWrapRef.current;
    if (!a || !wrap) return;
    const tick = () => {
      if (!a.paused && !isDraggingRef.current && !selectingRef.current && !pinchRef.current.active) {
        centerOnPlayhead();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [pxPerSec, duration]);

  // Time ruler (strictly synced to waveform zoom/pan/playback)
  useEffect(() => {
    let raf = 0; let running = true;
    const draw = () => {
      if (!running) return;
      const c = rulerRef.current; const wrap = waveWrapRef.current; if (!c || !wrap || !wsRef.current) { raf = requestAnimationFrame(draw); return; }
      const ctx = c.getContext('2d');
      const w = wrap.clientWidth; const h = 26; if (w <= 0) { raf = requestAnimationFrame(draw); return; }
      if (c.width !== Math.floor(w * devicePixelRatio) || c.height !== Math.floor(h * devicePixelRatio)) {
        c.width = w * devicePixelRatio; c.height = h * devicePixelRatio; c.style.height = h + 'px';
      }
      ctx.setTransform(1,0,0,1,0,0);
      ctx.scale(devicePixelRatio, devicePixelRatio);
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,w,h);
      ctx.strokeStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(0, h-0.5); ctx.lineTo(w, h-0.5); ctx.stroke();
      const pps = pxPerSec > 0 ? pxPerSec : (wsRef.current?.options?.minPxPerSec || 100);
      const scroll = wrap.scrollLeft || 0;
      const startSec = scroll / pps;
      const viewSec = w / pps;
      const endSec = Math.min(duration || 0, startSec + viewSec);
      // Choose tick spacing for ~60px per tick
      const steps = [0.001,0.002,0.005,0.01,0.02,0.05,0.1,0.2,0.5,1,2,5,10,20,30,60];
      let step = 1; for (const s of steps) { if (s * pps >= 60) { step = s; break; } }
      const first = Math.floor(startSec / step) * step;
      ctx.fillStyle = '#64748b'; ctx.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
      for (let t = first; t <= endSec + 1e-9; t += step) {
        const x = Math.round((t - startSec) * pps) + 0.5;
        const majorEvery = 5;
        const isMajor = (Math.round(t / step) % majorEvery) === 0;
        const tick = isMajor ? 10 : 6;
        ctx.strokeStyle = '#cbd5e1'; ctx.beginPath(); ctx.moveTo(x, h-1); ctx.lineTo(x, h-1-tick); ctx.stroke();
        if (isMajor) {
          const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
          const label = Math.max(0, Math.min(duration || 0, t)).toFixed(decimals);
          ctx.fillText(label + 's', x + 2, 12);
        }
      }
      const a = audioRef.current;
      if (a && playheadTimeRef.current) {
        const playSec = Math.max(0, Math.min(duration || 0, a.currentTime));
        playheadTimeRef.current.textContent = playSec.toFixed(2) + 's';
      }
      // Total duration label when fully in view
      if ((duration || 0) > 0 && viewSec >= (duration || 0) - 1e-6) {
        const decimals = viewSec < 1 ? 2 : viewSec < 10 ? 1 : 0;
        const text = (duration || 0).toFixed(decimals) + 's';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = '#334155';
        ctx.fillText(text, Math.max(0, w - tw - 4), 12);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { running = false; if (raf) cancelAnimationFrame(raf); };
  }, [pxPerSec, duration]);

  const vrange = viewRange.end - viewRange.start;
  const vrDecimals = vrange < 1 ? 3 : vrange < 10 ? 2 : 1;
  const rangeLabel = `${viewRange.start.toFixed(vrDecimals)}s — ${viewRange.end.toFixed(vrDecimals)}s`;

  if (!token) return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <Link href="/analysis" style={{ textDecoration:'none', color:'#2563eb' }}>{t('Back')}</Link>
      <div>{t('LoginToView')}</div>
    </div>
  );

  return (
    <div style={{
      maxWidth: chatOpen ? (960 + 420 + 16) : 960,
      margin: '24px auto',
      padding: '0 24px',
      display: 'grid',
      gridTemplateColumns: chatOpen ? 'minmax(0, 1fr) minmax(300px, 420px)' : '1fr',
      gap: 16,
      alignItems: 'start'
    }}>
      <div style={{ maxWidth: 960, width:'100%', margin: chatOpen ? 0 : '0 auto' }}>
      <Link href="/analysis" style={{ textDecoration:'none', color:'#2563eb' }}>{t('Back')}</Link>
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        {!editing ? (
          <>
            <h1 style={{ fontSize: 24, margin: '12px 0' }}>{title || (meta?.filename || '') || t('AnalysisTitle')}</h1>
            <button onClick={()=>setEditing(true)} title={t('EditTitle')} className="vh-btn vh-btn-outline" style={{ padding:'4px 8px' }}>✎</button>
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
            }} className="vh-btn vh-btn-primary" style={{ padding:'6px 10px' }}>{t('Save')}</button>
            <button onClick={()=>{ setTitle(meta?.title || meta?.filename || ''); setEditing(false); }} className="vh-btn vh-btn-outline" style={{ padding:'6px 10px' }}>{t('Cancel')}</button>
          </div>
        )}
      </div>
      {/* Sub-title: Waveform */}
      <div style={{ fontSize: 18, fontWeight: 600, margin: '8px 0 6px' }}>{t('Waveform')}</div>
      {meta && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:8 }}>
          <div style={{ color:'#64748b', fontSize:13 }}>{new Date(meta.created_at).toLocaleString()} · {meta.mimetype} · {(meta.size/1024).toFixed(1)} KB</div>
          {audioUrl && (
            <div style={{ display:'flex', alignItems:'center', gap:8, color:'#64748b', fontSize:12 }}>
              <button onClick={async ()=>{
                if (!gainOn) { setGainOn(true); setGainOpen(true); }
                else { setGainOn(false); setGainOpen(false); disableGainPipeline(); /* keep graph alive */ }
              }} className="vh-btn vh-btn-outline" style={{ padding:'2px 6px', borderRadius:6 }}>
                {t('AudioGain')} · {gainOn ? t('GainOn') : t('GainOff')}
              </button>
              {gainOn && (
                <>
                  <span>{t('GainLabel')}</span>
                  <input className="vh-range" type="range" min={1} max={5} step={0.1} value={gainVal} onChange={e=> setGainVal(parseFloat(e.target.value)||1)} style={{ width:160 }} />
                  <span style={{ minWidth:38, textAlign:'right' }}>{gainVal.toFixed(1)}x</span>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Waveform (client-rendered, smooth) */}
      { (loading.adv || loading.spec) && (
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
          onClick={onClick}
          onFocus={()=>setWaveFocused(true)}
          onBlur={()=>setWaveFocused(false)}
          onKeyDown={(e)=>{
            if (!waveFocused) return;
            if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault(); e.stopPropagation();
              const a = audioRef.current; if (!a) return;
              if (a.paused) { a.play?.(); } else { a.pause?.(); }
            }
          }}
          tabIndex={0}
          role="region"
          aria-label="waveform"
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          style={{ position:'relative', userSelect:'none', background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflowX:'auto', overflowY:'visible', touchAction:'none' }}
        >
          <div ref={playheadRef} style={{ position:'absolute', top:0, bottom:0, width:2, background:'#ef4444', pointerEvents:'none' }} />
          <div ref={playheadTimeRef} style={{ position:'absolute', bottom:0, transform:'translate(-50%, 100%)', color:'#ef4444', fontSize:12, background:'rgba(255,255,255,0.9)', padding:'1px 2px', borderRadius:4, pointerEvents:'none', zIndex:20 }} />
          <div ref={selectionRef} style={{ position:'absolute', top:0, bottom:0, background:'rgba(59,130,246,0.3)', border:'1px solid rgba(59,130,246,0.6)', display:'none', pointerEvents:'none' }} />
          <div ref={selectLabelRef} style={{ position:'absolute', top:4, left:0, background:'rgba(191,219,254,0.9)', color:'#1e3a8a', fontSize:12, padding:'2px 4px', borderRadius:4, display:'none', pointerEvents:'none' }} />
          <div style={{ position:'absolute', top:4, right:8, background:'#fff', border:'1px solid #e5e7eb', borderRadius:4, fontSize:12, padding:'2px 4px', color:'#1e293b', pointerEvents:'none' }}>{rangeLabel}</div>
        </div>
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
      <style>{`
        .vh-range{ -webkit-appearance:none; appearance:none; height:6px; background:#e5e7eb; border-radius:9999px; outline:none; }
        .vh-range:focus{ outline:none; }
        .vh-range::-webkit-slider-runnable-track{ height:6px; background:#e5e7eb; border-radius:9999px; }
        .vh-range::-webkit-slider-thumb{ -webkit-appearance:none; appearance:none; width:14px; height:14px; border-radius:9999px; background:#94a3b8; border:1px solid #cbd5e1; margin-top:-4px; }
        .vh-range::-moz-range-track{ height:6px; background:#e5e7eb; border-radius:9999px; }
        .vh-range::-moz-range-thumb{ width:14px; height:14px; border:none; border-radius:9999px; background:#94a3b8; }
      `}</style>

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

      {/* AI Analysis */}
      <div style={{ display:'flex', alignItems:'center', gap:8, margin:'12px 0 6px' }}>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{t('AIAnalysis')}</div>
        {aiText && (
          <button onClick={()=> setChatOpen(true)} className="vh-btn vh-btn-outline" style={{ padding:'6px 10px' }}>
            {t('StartConversation')}
          </button>
        )}
      </div>
      <div style={{ background:'#f8fafc', padding:16, borderRadius:12 }}>
        {!aiText && (
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
          <button disabled={aiBusy || aiSubmitted || !!aiText || !pcmPayload} onClick={async ()=>{
            if (!pcmPayload || aiSubmitted) return; setAiBusy(true); setAiErr('');
            try{
              const r = await fetch(ANALYSIS_BASE + `/records/${id}/ai_start`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ ...pcmPayload, lang }) });
              const j = await r.json(); if (!r.ok || j?.error) throw new Error(j?.error || 'start failed');
              // inform submitted; we don't poll to respect background requirement
              setAiErr('');
              setAiSubmitted(true);
              try { localStorage.setItem(`vh_ai_pending_${id}_${lang}`, '1'); } catch {}
            }catch(e){ setAiErr((e?.message)||'AI analysis failed'); setAiSubmitted(false); try { localStorage.removeItem(`vh_ai_pending_${id}_${lang}`); } catch {} }
            finally{ setAiBusy(false); }
          }} className="vh-btn vh-btn-primary" style={{ padding:'8px 12px', opacity: (aiBusy || aiSubmitted) ? 0.7 : 1, cursor: pcmPayload?'pointer':'not-allowed' }}>
            {aiBusy ? t('Analyzing') : aiSubmitted ? t('SubmittedBG') : t('RunAI')}
          </button>
          {/* Remove duplicate submitted hint since button text shows it */}
          {aiErr && <span style={{ color:'#b91c1c', fontSize:13 }}>{aiErr}</span>}
        </div>
        )}
        {aiMetrics && (
          <div style={{ marginTop:8, color:'#0f172a' }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(2, minmax(0,1fr))', gap:12 }}>
              <div><b>{t('HRShort')}:</b> {aiMetrics.heart_rate_bpm? aiMetrics.heart_rate_bpm.toFixed(0): '—'} bpm</div>
              <div><b>{t('S1S2Amp')}:</b> {aiMetrics.s1_s2_amplitude_ratio?.toFixed?.(2) || '—'}</div>
              <div><b>{t('SystoleSec')}:</b> {aiMetrics.systole_interval_sec?.mean?.toFixed?.(3) || '—'} ({aiMetrics.systole_interval_sec?.count||0})</div>
              <div><b>{t('DiastoleSec')}:</b> {aiMetrics.diastole_interval_sec?.mean?.toFixed?.(3) || '—'} ({aiMetrics.diastole_interval_sec?.count||0})</div>
              <div><b>{t('HFRatio')}:</b> {aiMetrics.high_freq_energy_ratio?.toFixed?.(3) || '—'}</div>
            </div>
            {aiMetrics.interpretation && (
              <div style={{ marginTop:8, fontSize:13, color:'#475569' }}>
                <div>{aiMetrics.interpretation.heart_rate_comment || ''}</div>
                <div>{aiMetrics.interpretation.amplitude_comment || ''}</div>
                <div>{aiMetrics.interpretation.murmur_comment || ''}</div>
              </div>
            )}
          </div>
        )}
        {aiText && (
          <>
            <div
              style={{ marginTop:12, lineHeight:1.6, color:'#0f172a' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(aiText) }}
            />
            <div style={{ marginTop:8, fontSize:12, color:'#64748b' }}>{t('AIGeneratedAt') + ' ' + (aiMetrics?.generated_at ? new Date(aiMetrics.generated_at).toLocaleString() : meta?.ai_generated_at ? new Date(meta.ai_generated_at).toLocaleString() : '')}</div>
          </>
        )}
      </div>
      </div>
      {chatOpen && (
        <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', display:'flex', flexDirection:'column', marginTop: 12, minWidth:300, maxWidth:420, alignSelf:'start', position:'sticky', top: navOffset, height: `calc(100vh - ${navOffset + 16}px)` }}>
          <div style={{ padding:'10px 12px', borderBottom:'1px solid #e5e7eb', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
            <div style={{ fontWeight:600, display:'flex', alignItems:'center', gap:8 }}>
              <span>{t('AIConversation')}</span>
              {me && (
                <span style={{ display:'inline-flex', alignItems:'center', gap:6, color:'#64748b', fontWeight:400, fontSize:12 }}>
                  {me.avatar_media_id ? (
                    <img src={`${MEDIA_BASE}/file/${me.avatar_media_id}?v=${me.avatar_media_id}`} alt="me" width={16} height={16} style={{ width:16, height:16, borderRadius:9999, objectFit:'cover' }} />
                  ) : (
                    <span style={{ width:16, height:16, borderRadius:9999, background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:10 }}>
                      {(me.display_name||me.email||'U').trim()[0]?.toUpperCase?.()||'U'}
                    </span>
                  )}
                  <span>{me.display_name || me.email}</span>
                </span>
              )}
            </div>
            <button onClick={()=> setChatOpen(false)} className="vh-btn vh-btn-outline" style={{ padding:'4px 8px' }}>✕</button>
          </div>
          <div ref={chatScrollRef} style={{ flex:1, overflowY:'auto', padding:12, display:'flex', flexDirection:'column', gap:10 }}>
            {chatMsgs.length===0 && (
              <div style={{ display:'flex', gap:8, alignItems:'flex-start' }}>
                <div style={{ width:28, height:28, borderRadius:9999, background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:12 }}>AI</div>
                <div style={{ maxWidth: 280, background:'#f1f5f9', color:'#0f172a', padding:'8px 10px', borderRadius:12, lineHeight:1.5 }}>
                  <div style={{ whiteSpace:'pre-wrap' }}>
                    {lang==='zh'
                      ? '你好，我是智能心音助手。\n我可以基于本次分析结果，帮你解读报告、回答疑问，或给出复测与就医建议。\n请告诉我你的具体问题。'
                      : "Hi! I'm your heart-sound assistant.\nI can interpret this analysis, answer questions, and suggest retesting or when to see a doctor.\nWhat would you like to know?"}
                  </div>
                </div>
              </div>
            )}
            {chatMsgs.map((m, idx) => {
              const isUser = m.role==='user';
              return (
                <div key={idx} style={{ display:'flex', gap:8, alignItems:'flex-start', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
                  {!isUser && (
                    <div style={{ width:28, height:28, borderRadius:9999, background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:12 }}>AI</div>
                  )}
                  <div style={{ maxWidth: 280, background: isUser ? '#111' : '#f1f5f9', color: isUser ? '#fff' : '#0f172a', padding:'8px 10px', borderRadius:12, lineHeight:1.5 }}>
                    {isUser ? (
                      <div style={{ whiteSpace:'pre-wrap' }}>{m.content}</div>
                    ) : (
                      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content || '') }} />
                    )}
                    {(!m.content && !isUser && chatBusy) && (
                      <div style={{ marginTop:6, color:'#64748b', fontSize:12 }}>
                        <span>Thinking…</span>
                      </div>
                    )}
                  </div>
                  {isUser && (
                    me?.avatar_media_id ? (
                      <img src={`${MEDIA_BASE}/file/${me.avatar_media_id}?v=${me.avatar_media_id}`} alt="me" width={28} height={28} style={{ width:28, height:28, borderRadius:9999, objectFit:'cover', display:'block' }} />
                    ) : (
                      <div style={{ width:28, height:28, borderRadius:9999, background:'#111', color:'#fff', display:'grid', placeItems:'center', fontSize:12 }}>
                        {(me?.display_name||me?.email||'U')?.trim?.()?.[0]?.toUpperCase?.() || 'U'}
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ padding:12, borderTop:'1px solid #e5e7eb' }}>
            <form onSubmit={(e)=>{ e.preventDefault(); const v = e.target.elements.msg?.value?.trim(); if (!v || chatBusy) return; e.target.reset(); sendChat(v); }} style={{ display:'flex', gap:8 }}>
              <input name="msg" placeholder={t('TypeMessage')} autoComplete="off" style={{ flex:1, padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
              {!chatBusy ? (
                <button type="submit" className="vh-btn vh-btn-primary">{t('Send')}</button>
              ) : (
                <button type="button" onClick={cancelChat} className="vh-btn vh-btn-stop" title={lang==='zh' ? '终止生成' : 'Stop generation'}>
                  {lang==='zh' ? '■ 终止' : '■ Stop'}
                </button>
              )}
            </form>
            {chatErr && <div style={{ marginTop:6, color:'#b91c1c', fontSize:12 }}>{chatErr}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
