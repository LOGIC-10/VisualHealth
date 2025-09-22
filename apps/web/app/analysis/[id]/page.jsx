"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../../components/i18n';
import { renderMarkdown } from '../../../components/markdown';
import { API } from '../../../lib/api';

import WaveSurfer from 'wavesurfer.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import ZoomPlugin from 'wavesurfer.js/dist/plugins/zoom.esm.js';

const VIZ_BASE = API.viz;
const AUTH_BASE = API.auth;

const MEDIA_BASE = API.media;
const ANALYSIS_BASE = API.analysis;
const LLM_BASE = API.llm;

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
  const timelineRef = useRef(null);
  const playLabelRef = useRef(null);
  const audioRef = useRef(null);
  const wsRef = useRef(null);
  const lastXRef = useRef(0);
  const isDraggingRef = useRef(false);
  const pinchRef = useRef({ active:false, id1:null, id2:null, startDist:0, startPx:0, startScroll:0 });
  const [specUrl, setSpecUrl] = useState(null);
  const [adv, setAdv] = useState(null);
  const [audioHash, setAudioHash] = useState(null);
  const [loading, setLoading] = useState({ decode: false, extra: false, adv: false, spec: false });
  const [progress, setProgress] = useState(0);
  const [audioError, setAudioError] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMetrics, setAiMetrics] = useState(null);
  const [aiText, setAiText] = useState('');
  const [aiErr, setAiErr] = useState('');
  const [aiSubmitted, setAiSubmitted] = useState(false);
  const [pcmPayload, setPcmPayload] = useState(null);
  const [useHsmm, setUseHsmm] = useState(false);
  const [quality, setQuality] = useState(null);
  const [openResp, setOpenResp] = useState(true);
  const [openSounds, setOpenSounds] = useState(true);
  const [openMurmur, setOpenMurmur] = useState(true);
  const [openRhythm, setOpenRhythm] = useState(true);
  const [openWave, setOpenWave] = useState(true);
  const [openSpec, setOpenSpec] = useState(true);
  const [openClinical, setOpenClinical] = useState(true);
  const [openFeatures, setOpenFeatures] = useState(true);
  const [openExtras, setOpenExtras] = useState(true);
  const [openAI, setOpenAI] = useState(true);
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
  const contentRef = useRef(null);
  const [contentWidth, setContentWidth] = useState(960);
  useEffect(() => {
    try {
      const nav = document.querySelector('nav');
      if (nav) {
        const h = Math.ceil(nav.getBoundingClientRect().height);
        setNavOffset(h + 16);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try { setUseHsmm(localStorage.getItem('vh_use_hsmm') === '1'); } catch {}
  }, []);
  useEffect(() => {
    const el = contentRef.current; if (!el) return;
    const ro = new ResizeObserver(() => {
      try { setContentWidth(Math.max(600, Math.floor(el.clientWidth || 960))); } catch {}
    });
    ro.observe(el);
    try { setContentWidth(Math.max(600, Math.floor(el.clientWidth || 960))); } catch {}
    return () => { try { ro.disconnect(); } catch {} };
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
    // Always include latest clinical PCG metrics (UI card data)
    try { if (adv) ctx.push('临床级 PCG 分析 (clinical_pcg):\n```json\n' + JSON.stringify(adv) + '\n```'); } catch {}
    // Include basic features
    try { if (features) ctx.push('特征 (features):\n```json\n' + JSON.stringify(features) + '\n```'); } catch {}
    // Include previous AI text, if any, for continuity（不再包含旧算法指标）
    if (meta?.ai) {
      const ttxt = (meta.ai.texts && meta.ai.texts[lang]) || meta.ai.text || '';
      if (ttxt) ctx.push(`上次AI报告 (Markdown):\n\n${ttxt}`);
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

  // SSE 推送（spec_done/pcg_done）；不可用时采用500ms起步指数退避到3s的短轮询
  useEffect(() => {
    if (!token || !id) return;
    let es = null; let stopped = false; let backoff = 500;
    const maxBackoff = 3000;
    const poll = async () => {
      if (stopped) return;
      try {
        const r = await fetch(ANALYSIS_BASE + `/records/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) {
          const rec = await r.json();
          if (rec?.adv && !adv) setAdv(rec.adv);
          if (rec?.spec_media_id && !specUrl) {
            const fr = await fetch(MEDIA_BASE + `/file/${rec.spec_media_id}`, { headers: { Authorization: `Bearer ${token}` } });
            if (fr.ok) { const b = await fr.blob(); setSpecUrl(URL.createObjectURL(b)); }
          }
        }
      } catch {}
      if (stopped) return;
      const wait = Math.min(maxBackoff, backoff);
      backoff = Math.min(maxBackoff, Math.floor(backoff * 2));
      setTimeout(poll, wait);
    };
    try {
      const url = ANALYSIS_BASE + `/records/${id}/stream?access_token=${encodeURIComponent(token)}`;
      es = new EventSource(url);
      es.addEventListener('spec_done', async (ev) => {
        try {
          const data = JSON.parse(ev.data||'{}');
          const smid = data?.specMediaId || data?.spec_media_id;
          if (smid) {
            const fr = await fetch(MEDIA_BASE + `/file/${smid}`, { headers: { Authorization: `Bearer ${token}` } });
            if (fr.ok) { const b = await fr.blob(); setSpecUrl(URL.createObjectURL(b)); }
          }
        } catch {}
      });
      es.addEventListener('pcg_done', (ev) => {
        try { const data = JSON.parse(ev.data||'{}'); if (data?.adv) setAdv(data.adv); } catch {}
      });
      es.onerror = () => { try { es?.close(); } catch {}; poll(); };
    } catch {
      poll();
    }
    return () => { stopped = true; try { es?.close(); } catch {}; };
  }, [token, id]);

  // SSE已覆盖spec/adv更新；无需额外轮询逻辑

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
      // Compute audio SHA-256 (raw bytes) for caching key
      try {
        const bufAll = await blob.arrayBuffer();
        const h = await crypto.subtle.digest('SHA-256', bufAll);
        const hex = Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('');
        setAudioHash(hex);
      } catch {}
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
        const tDec0 = performance.now();
        const buf = await audioCtx.decodeAudioData(arr.slice(0));
        const tDec1 = performance.now();
        const ch = buf.getChannelData(0);
        // downsample to ~8k to limit payload
        const targetSR = 8000;
        const ratio = Math.max(1, Math.floor(buf.sampleRate / targetSR));
        const ds = new Float32Array(Math.ceil(ch.length / ratio));
        const tDs0 = performance.now();
        for (let i = 0; i < ds.length; i++) ds[i] = ch[i * ratio] || 0;
        const tDs1 = performance.now();
        setLoading(s=>({ ...s, decode:false })); setProgress(p=>p+0.25);
        const payload = { sampleRate: Math.round(buf.sampleRate / ratio), pcm: Array.from(ds) };
        setPcmPayload(payload);
        // (internal) local timing available via console only
        try { console.info('[spec] decodeMs', (tDec1 - tDec0).toFixed(1), 'downsampleMs', (tDs1 - tDs0).toFixed(1)); } catch {}
        // run in parallel (fire-and-forget; UI should not await batch)
        void (async ()=>{
          const resp = await fetch(VIZ_BASE + '/features_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
          if (resp.ok) setExtra(await resp.json());
          setLoading(s=>({ ...s, extra:false }));
        })();
        needAdv && void (async ()=>{
          const t0 = performance.now();
          // Prefer media-based endpoint to avoid large JSON
          let resp = null;
          try {
            if (meta?.media_id) {
              // Quality gate for media; fallback to PCM when media decode unsupported
              let pass = true;
              try {
                const qr = await fetch(VIZ_BASE + '/pcg_quality_media', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ mediaId: meta.media_id }) });
                if (qr.ok) {
                  const qj = await qr.json();
                  setQuality(qj);
                  pass = !!(qj.isHeart && qj.qualityOk);
                } else {
                  pass = false;
                }
              } catch { pass = false; }
              if (!pass) {
                try {
                  const qr2 = await fetch(VIZ_BASE + '/pcg_quality_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
                  const qj2 = await qr2.json();
                  setQuality(qj2);
                  pass = !!(qj2.isHeart && qj2.qualityOk);
                } catch { pass = false; }
              }
              if (!pass) { setLoading(s=>({ ...s, adv:false })); return; }
              resp = await fetch(VIZ_BASE + '/pcg_advanced_media', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ mediaId: meta.media_id, hash: audioHash, useHsmm }) });
            }
          } catch {}
          if (!resp || !resp.ok) {
            // Fallback to PCM endpoint
            try {
              // Quality gate for PCM
              try {
                const qr2 = await fetch(VIZ_BASE + '/pcg_quality_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
                const qj2 = await qr2.json();
                setQuality(qj2);
                if (!(qj2.isHeart && qj2.qualityOk)) {
                  setLoading(s=>({ ...s, adv:false }));
                  return;
                }
              } catch {}
              resp = await fetch(VIZ_BASE + '/pcg_advanced', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, hash: audioHash, useHsmm }) });
            } catch {}
          }
          const t1 = performance.now();
          if (resp && resp.ok) {
            try {
              const comp = parseFloat(resp.headers.get('x-compute-time')||'');
              console.info('[adv] reqMs', (t1-t0).toFixed(1), 'serverMs', isNaN(comp)?'—':comp.toFixed(1));
            } catch {}
            const data = await resp.json();
            setAdv(data);
            // 后台持久化，便于其他会话直接加载
            try { await fetch(ANALYSIS_BASE + `/records/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ adv: data, audioHash }) }); } catch {}
          }
          setLoading(s=>({ ...s, adv:false })); if (per>0) setProgress(p=>p+per);
        })();
        const width = Math.max(800, Math.min(1400, Math.floor(contentWidth)));
        needSpec && void (async ()=>{
          const tReq0 = performance.now();
          const resp = await fetch(VIZ_BASE + '/spectrogram_pcm', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...payload, hash: audioHash, maxFreq:2000, width, height: 320 }) });
          const tReq1 = performance.now();
          if (resp.ok) {
            const imgBlob = await resp.blob();
            setSpecUrl(URL.createObjectURL(imgBlob));
            // console-only timings
            try {
              const total = parseFloat(resp.headers.get('x-compute-time')||'');
              const stft = parseFloat(resp.headers.get('x-stft-time')||'');
              const plot = parseFloat(resp.headers.get('x-plot-time')||'');
              console.info('[spec] reqMs', (tReq1-tReq0).toFixed(1), 'serverMs', isNaN(total)?'—':total.toFixed(1), 'stftMs', isNaN(stft)?'—':stft.toFixed(1), 'plotMs', isNaN(plot)?'—':plot.toFixed(1));
            } catch {}
            // cache spectrogram into media and patch record (async; don't block render)
            (async () => {
              try {
                const fd = new FormData();
                fd.append('file', new File([imgBlob], 'spectrogram.png', { type: 'image/png' }));
                const up = await fetch(API.media + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fd });
                const j = await up.json();
                if (j?.id) {
                  await fetch(ANALYSIS_BASE + `/records/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ specMediaId: j.id, audioHash }) });
                }
              } catch {}
            })();
          }
          setLoading(s=>({ ...s, spec:false })); if (per>0) setProgress(p=>p+per);
        })();
      } catch {}
    })();
  }, [meta, token]);

  // 不再自动调用后端 ai_start 进行计算；如需自动生成，可在此直接调用 LLM 服务
  // Init WaveSurfer bound to the HTMLAudioElement (so bottom control bar controls everything)
  useEffect(() => {
    if (!audioUrl || !waveWrapRef.current || !audioRef.current) return;
    if (wsRef.current) { try { wsRef.current.destroy(); } catch {} wsRef.current = null; }
    const ws = WaveSurfer.create({
      container: waveWrapRef.current,
      media: audioRef.current,
      height: 160,
      minPxPerSec: pxPerSec,
      waveColor: '#4F4A85',
      progressColor: '#38B3D6',
      cursorColor: '#FF0000',
      cursorWidth: 2,
      normalize: true,
      interact: false,
      plugins: [
        TimelinePlugin.create({ container: timelineRef.current }),
        ZoomPlugin.create({ maxZoom: 100, minZoom: 1 })
      ],
    });
    ws.on('ready', () => {
      const d = ws.getDuration();
      setDuration(d);
      const cw = waveWrapRef.current?.clientWidth || 800;
      const minPx = d > 0 ? ((cw + 2) / d) : 100;
      setPxPerSec(minPx);
      ws.zoom(minPx);
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

  // Red time label near playhead (overlay)
  useEffect(() => {
    let raf = 0; let running = true;
    const draw = () => {
      if (!running) return;
      const wrap = waveWrapRef.current; const a = audioRef.current; const label = playLabelRef.current;
      if (!wrap || !a || !label || !wsRef.current) { raf = requestAnimationFrame(draw); return; }
      const pps = (pxPerSec && pxPerSec > 0) ? pxPerSec : (wsRef.current?.options?.minPxPerSec || 100);
      const w = wrap.clientWidth || 0;
      const cur = Math.max(0, Math.min(duration || 0, a.currentTime || 0));
      const playX = (cur * pps) - (wrap.scrollLeft || 0);
      const viewSec = (w > 0 && pps > 0) ? (w / pps) : 0;
      const decimals = viewSec < 1 ? 3 : viewSec < 10 ? 2 : 1;
      const txt = cur.toFixed(decimals) + 's';
      try { label.textContent = txt; } catch {}
      const labelW = label.offsetWidth || 40;
      let left = Math.round(playX);
      left = Math.max(4 + Math.round(labelW/2), Math.min(w - 4 - Math.round(labelW/2), left));
      label.style.left = left + 'px';
      label.style.display = (w > 0) ? 'block' : 'none';
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { running = false; if (raf) cancelAnimationFrame(raf); };
  }, [duration, pxPerSec]);

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
    // Use pxPerSec as the single source of truth for mapping time<->pixels
    const secPerPx = 1 / currentPx;
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
    // Keep our wheel handler to avoid page zoom and to drive ws.zoom for plugin sync
    el.addEventListener('wheel', onWheelNative, { passive: false });
    // Also block Safari page-zoom while letting our zoom logic run
    const prevent = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    el.addEventListener('gesturestart', prevent, { passive: false });
    el.addEventListener('gesturechange', prevent, { passive: false });
    el.addEventListener('gestureend', prevent, { passive: false });
    el.style.overscrollBehavior = 'contain';
    return () => {
      el.removeEventListener('wheel', onWheelNative);
      el.removeEventListener('gesturestart', prevent);
      el.removeEventListener('gesturechange', prevent);
      el.removeEventListener('gestureend', prevent);
    };
  }, [onWheelNative]);

  const downXRef = useRef(0);
  const movedRef = useRef(false);
  const [selectionRef, setSelectionRef] = useState(null);
  const [shiftPressed, setShiftPressed] = useState(false);
  useEffect(() => {
    const onKeyDown = (e) => setShiftPressed(e.shiftKey);
    const onKeyUp = (e) => setShiftPressed(e.shiftKey);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, []);

  function onMouseDown(e){
    if (shiftPressed) {
      const wrapper = waveWrapRef.current; if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const xAbs = e.clientX - rect.left + wrapper.scrollLeft;
      const startSec = xAbs / (pxPerSec || 1);
      setSelectionRef({ startX: xAbs, startSec, currentX: xAbs, currentSec: startSec });
    } else {
      isDraggingRef.current = true; downXRef.current = lastXRef.current = e.clientX; movedRef.current = false;
    }
  }
  function onMouseMove(e){
    const wrapper = waveWrapRef.current; if (!wrapper) return;
    if (selectionRef && shiftPressed) {
      const rect = wrapper.getBoundingClientRect();
      const xAbs = e.clientX - rect.left + wrapper.scrollLeft;
      setSelectionRef(prev => ({ ...prev, currentX: xAbs, currentSec: xAbs / (pxPerSec || 1) }));
      return;
    }
    if (!isDraggingRef.current) return;
    const dx = e.clientX - lastXRef.current; lastXRef.current = e.clientX;
    const rect = wrapper.getBoundingClientRect();
    const pps = pxPerSec || 1;
    const maxScroll = Math.max(0, pps * duration - rect.width);
    if (Math.abs(e.clientX - downXRef.current) > 3) movedRef.current = true;
    wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, wrapper.scrollLeft - dx));
  }
  function onMouseUp(e){
    const wrapper = waveWrapRef.current; if (!wrapper) { isDraggingRef.current = false; return; }
    if (selectionRef && shiftPressed) {
      const rect = wrapper.getBoundingClientRect();
      const startX = Math.min(selectionRef.startX, selectionRef.currentX);
      const endX = Math.max(selectionRef.startX, selectionRef.currentX);
      if (endX - startX < 10) {
        const x = e.clientX - rect.left + wrapper.scrollLeft;
        const sec = Math.max(0, Math.min(duration, x / (pxPerSec || 1)));
        if (audioRef.current) audioRef.current.currentTime = sec;
      } else {
        const pps0 = pxPerSec || 1;
        const sSec = Math.max(0, Math.min(duration, startX / pps0));
        const eSec = Math.max(0, Math.min(duration, endX / pps0));
        const newZoomSec = Math.max(1e-6, eSec - sSec);
        const rectW = rect.width;
        const newPxPerSec = (rectW + 2) / newZoomSec;
        wsRef.current?.zoom(newPxPerSec);
        setPxPerSec(newPxPerSec);
        const centerSec = (sSec + eSec) / 2;
        if (audioRef.current) audioRef.current.currentTime = centerSec;
        requestAnimationFrame(() => {
          const pps = pxPerSec || newPxPerSec;
          const contentWidth = wrapper.scrollWidth || 0;
          const maxScroll = Math.max(0, contentWidth - rectW);
          const newScrollLeft = Math.max(0, centerSec * (pps) - rectW / 2);
          wrapper.scrollLeft = Math.max(0, Math.min(maxScroll, newScrollLeft));
        });
      }
      setSelectionRef(null);
    } else {
      // Click-to-seek if not dragging
      if (!movedRef.current && duration) {
        const rect = wrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const sec = Math.max(0, Math.min(duration, (wrapper.scrollLeft + x) / (pxPerSec || 1)));
        if (audioRef.current) audioRef.current.currentTime = sec;
      }
    }
    isDraggingRef.current = false;
  }

  function onTouchStart(e){
    if (e.touches && e.touches.length === 2) {
      pinchRef.current.startDist = 0;
      pinchRef.current.startPx = pxPerSec || 1;
      pinchRef.current.startScroll = waveWrapRef.current?.scrollLeft || 0;
    }
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
        pinchRef.current.startPx = pxPerSec || 1;
      } else {
        const scale = dist / pinchRef.current.startDist;
        const centerX = (t1.clientX + t2.clientX) / 2 - rect.left;
        const frac = Math.max(0, Math.min(1, centerX / rect.width));
        const pivotSec = (waveWrapRef.current.scrollLeft + centerX) / (pxPerSec || 1);
        const minPx = duration > 0 ? (rect.width / duration) : 10;
        const next = Math.max(minPx, Math.min(5000, (pinchRef.current.startPx || 1) * scale));
        setPxPerSec(next);
        wsRef.current.zoom(next);
        const newScrollLeft = Math.max(0, pivotSec * next - frac * rect.width);
        const maxScroll = Math.max(0, next * duration - rect.width);
        requestAnimationFrame(() => { waveWrapRef.current.scrollLeft = Math.max(0, Math.min(maxScroll, newScrollLeft)); });
      }
    }
  }
  function onTouchEnd(){ pinchRef.current.startDist = 0; }

  // Timeline is rendered by WaveSurfer TimelinePlugin

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
      <div ref={contentRef} style={{ maxWidth: 960, width:'100%', margin: chatOpen ? 0 : '0 auto' }}>
      {quality && (!quality.isHeart || !quality.qualityOk) && (
        <div style={{ marginBottom:12, padding:12, border:'1px solid #fecaca', background:'#fef2f2', color:'#991b1b', borderRadius:12 }}>
          本音频疑似非心音或质量不足，已跳过心音分析。建议在安静环境靠近胸前重新录制（≥6秒）。
        </div>
      )}
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
      <div className="vh-sec-head" style={{ fontSize: 18, fontWeight: 600, margin: '8px 0 6px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {/* waveform icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M2 12h3l2-6 3 12 2-6h8" stroke="#0f172a" strokeWidth="1.5"/></svg>
          <span>{t('Waveform')}</span>
        </div>
      </div>
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
      {(loading.adv || loading.spec) && (
        <div style={{ marginTop:8, height:6, background:'#e5e7eb', borderRadius:6, overflow:'hidden' }}>
          <div style={{ width: `${Math.round(Math.min(1, progress)*100)}%`, height:'100%', background:'#2563eb', transition:'width 200ms linear' }} />
        </div>
      )}
      {(audioError ? (
        <div style={{ padding:12, color:'#b91c1c', background:'#fef2f2', border:'1px solid #fecaca', borderRadius:12 }}>
          {audioError}
        </div>
      ) : (
        <div style={{ position:'relative' }}>
          <div
            ref={waveWrapRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onTouchStart={onTouchStart}
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
            onTouchEnd={()=>{ pinchRef.current.startDist = 0; }}
            style={{ position:'relative', userSelect:'none', background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflowX:'auto', overflowY:'hidden', touchAction:'none' }}
          />
          {selectionRef && shiftPressed && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: Math.min(selectionRef.startX, selectionRef.currentX) - (waveWrapRef.current?.scrollLeft || 0),
              width: Math.abs(selectionRef.currentX - selectionRef.startX),
              height: '100%',
              backgroundColor: 'rgba(37, 99, 235, 0.1)',
              border: '1px solid rgba(37, 99, 235, 0.3)',
              pointerEvents: 'none',
              borderRadius: '4px',
              zIndex: 10
            }} />
          )}
          {/* Red time label near playhead */}
          <div ref={playLabelRef} style={{ position:'absolute', top: 6, transform:'translateX(-50%)', padding:'2px 6px', fontSize:12, color:'#ef4444', background:'rgba(255,255,255,0.9)', border:'1px solid #fecaca', borderRadius:6, pointerEvents:'none' }} />
        </div>
      ))}

      {/* Timeline under waveform */}
      {(
        <div ref={timelineRef} style={{ width:'100%', height: 26, background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, borderTopLeftRadius:0, borderTopRightRadius:0, borderTop:'none' }} />
      )}

      {audioUrl && (
        <audio ref={audioRef} controls src={audioUrl} style={{ marginTop: 8, width:'100%' }} />
      )}

      {/* Sub-title: Spectrogram */}
      <div className="vh-sec-head" style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <div title={openSpec? t('Collapse') : t('Expand')} className={"vh-arrow "+(openSpec?"vh-rot":"")} onClick={()=>setOpenSpec(v=>!v)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
          </div>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 18V8M8 18V4M12 18V10M16 18V6M20 18V12" stroke="#0f172a" strokeWidth="1.5"/></svg>
          <span>{t('Spectrogram')}</span>
        </div>
      </div>
      {/* Static spectrogram below playback bar (colored, with axes) */}
      <div className={"vh-collapse "+(openSpec?"open":"closed")}>
        <div style={{ marginTop: 12, background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, overflow:'hidden', minHeight: 200, position:'relative' }}>
          {!specUrl && (
            <div style={{ position:'absolute', inset:0, display:'grid', placeItems:'center', color:'#64748b' }}>
              <div className="vh-spin" />
            </div>
          )}
          {specUrl && <img src={specUrl} alt="spectrogram" style={{ display:'block', width:'100%', height:'auto' }} />}
        </div>
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
      <style>{`
        .vh-arrow{ opacity:0; transition: opacity 120ms ease, transform 120ms ease; cursor:pointer; pointer-events:none; display:inline-flex; }
        .vh-sec-head:hover .vh-arrow{ opacity:1; pointer-events:auto; }
        .vh-rot{ transform: rotate(90deg); }
        .vh-collapse{ overflow:hidden; transition:max-height 200ms ease, opacity 200ms ease; opacity:1; }
        .vh-collapse.closed{ max-height:0; opacity:0; pointer-events:none; }
        .vh-collapse.open{ max-height:4000px; opacity:1; }
      `}</style>

      {/* Clinical PCG Analysis */}
      {adv && (
        <>
          <div className="vh-sec-head" style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div title={openClinical? t('Collapse'):t('Expand')} className={"vh-arrow "+(openClinical?"vh-rot":"")} onClick={()=>setOpenClinical(v=>!v)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
            </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 3v5a4 4 0 1 0 8 0V3" stroke="#0f172a" strokeWidth="1.5"/><path d="M14 14a4 4 0 0 1-8 0" stroke="#0f172a" strokeWidth="1.5"/><circle cx="18" cy="10" r="2" stroke="#0f172a" strokeWidth="1.5"/><path d="M18 12v4a4 4 0 0 1-4 4h-2" stroke="#0f172a" strokeWidth="1.5"/></svg>
              <span>{t('ClinicalAnalysis')}</span>
            </div>
          </div>
          <div className={"vh-collapse "+(openClinical?"open":"closed")}>
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
            <div><b>{t('S1Width')}:</b> {adv.s1DurMs?.toFixed?.(1) || '—'}</div>
            <div><b>{t('S2Width')}:</b> {adv.s2DurMs?.toFixed?.(1) || '—'}</div>
            <div><b>{t('S1Intensity')}:</b> {adv.s1Intensity?.toFixed?.(3) || '—'}</div>
            <div><b>{t('S2Intensity')}:</b> {adv.s2Intensity?.toFixed?.(3) || '—'}</div>
            <div><b>{t('SysHF')}:</b> {adv.sysHighFreqEnergy ? adv.sysHighFreqEnergy.toFixed(2) : '—'}</div>
            <div><b>{t('DiaHF')}:</b> {adv.diaHighFreqEnergy ? adv.diaHighFreqEnergy.toFixed(2) : '—'}</div>
            <div><b>{t('SysShape')}:</b> {adv.sysShape || '—'}</div>
            <div><b>{t('SNR')}:</b> {adv.qc?.snrDb?.toFixed?.(1) || '—'}</div>
            <div><b>{t('MotionPct')}:</b> {adv.qc ? Math.round(adv.qc.motionPct*100) : '—'}%</div>
            <div><b>{t('UsablePct')}:</b> {adv.qc ? Math.round(adv.qc.usablePct*100) : '—'}%</div>
            <div><b>{t('ContactNoise')}:</b> {adv.qc?.contactNoiseSuspected ? (lang==='zh'?'是':'Yes') : (lang==='zh'?'否':'No')}</div>
          </div>
            <div style={{ gridColumn:'1 / -1', marginTop: 6, fontSize: 12, color:'#64748b' }}>{t('Disclaimer')}</div>
          </div>
          </div>
        </>
      )}

      {adv?.extras && (
        <>
          <div className="vh-sec-head" style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div title={openExtras? t('Collapse') : t('Expand')} className={"vh-arrow "+(openExtras?"vh-rot":"")} onClick={()=>setOpenExtras(v=>!v)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
              </div>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" stroke="#0f172a" strokeWidth="1.2"/></svg>
              <span>{t('Extras')}</span>
            </div>
          </div>
          <div className={"vh-collapse "+(openExtras?"open":"closed")}>
          <div style={{ display: 'grid', gridTemplateColumns:'repeat(2, minmax(0,1fr))', gap:12 }}>
            {/* Respiration & S2 split typing */}
            <div style={{ background:'#f8fafc', padding:16, borderRadius:12 }}>
              <div className="vh-sec-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:6 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:600 }}>
              <div title={openResp? t('Collapse') : t('Expand')} className={"vh-arrow "+(openResp?"vh-rot":"")} onClick={()=>setOpenResp(v=>!v)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
                  </div>
                  {/* lungs icon */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 3v8c0 1.657-1.343 3-3 3H4a3 3 0 0 1-3-3V9c0-1.105.895-2 2-2h1c.552 0 1 .448 1 1v3" stroke="#0f172a" strokeWidth="1.5"/><path d="M15 3v8c0 1.657 1.343 3 3 3h2a3 3 0 0 0 3-3V9c0-1.105-.895-2-2-2h-1c-.552 0-1 .448-1 1v3" stroke="#0f172a" strokeWidth="1.5"/></svg>
                  <span>{t('RespAndSplit')}</span>
                </div>
              </div>
              <div className={"vh-collapse "+(openResp?"open":"closed")}>
                <>
                  <div><b>{t('RespRate')}:</b> {adv.extras.respiration?.respRate ? adv.extras.respiration.respRate.toFixed(1) : '—'} /min</div>
                  <div><b>{t('RespDominance')}:</b> {adv.extras.respiration?.respDominance?.toFixed?.(2) || '—'}</div>
                  <div><b>{t('S2SplitType')}:</b> {adv.extras.respiration?.s2SplitType || '—'}</div>
                  <div><b>{t('S2SplitCorr')}:</b> {adv.extras.respiration?.s2SplitCorr?.toFixed?.(2) || '—'}</div>
                </>
              </div>
            </div>
            {/* Additional sounds */}
            <div style={{ background:'#f8fafc', padding:16, borderRadius:12 }}>
              <div className="vh-sec-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:6 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:600 }}>
                  <div title={openSounds? t('Collapse') : t('Expand')} className={"vh-arrow "+(openSounds?"vh-rot":"")} onClick={()=>setOpenSounds(v=>!v)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
                  </div>
                  {/* spark/wave icon */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 12c2 0 2-6 4-6s2 12 4 12 2-12 4-12 2 6 4 6" stroke="#0f172a" strokeWidth="1.5"/></svg>
                  <span>{t('AdditionalSounds')}</span>
                </div>
              </div>
              <div className={"vh-collapse "+(openSounds?"open":"closed")}>
                <>
                  <div><b>{t('S3Prob')}:</b> {(adv.extras.additionalSounds?.s3Prob!=null)? Math.round(adv.extras.additionalSounds.s3Prob*100): '—'}%</div>
                  <div><b>{t('S4Prob')}:</b> {(adv.extras.additionalSounds?.s4Prob!=null)? Math.round(adv.extras.additionalSounds.s4Prob*100): '—'}%</div>
                  <div><b>{t('EjectionClickProb')}:</b> {(adv.extras.additionalSounds?.ejectionClickProb!=null)? Math.round(adv.extras.additionalSounds.ejectionClickProb*100): '—'}%</div>
                  <div><b>{t('OpeningSnapProb')}:</b> {(adv.extras.additionalSounds?.openingSnapProb!=null)? Math.round(adv.extras.additionalSounds.openingSnapProb*100): '—'}%</div>
                </>
              </div>
            </div>
            {/* Murmur descriptors */}
            <div style={{ background:'#f8fafc', padding:16, borderRadius:12 }}>
              <div className="vh-sec-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:6 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:600 }}>
                  <div title={openMurmur? t('Collapse') : t('Expand')} className={"vh-arrow "+(openMurmur?"vh-rot":"")} onClick={()=>setOpenMurmur(v=>!v)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
                  </div>
                  {/* stethoscope icon */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 3v5a4 4 0 1 0 8 0V3" stroke="#0f172a" strokeWidth="1.5"/><path d="M14 14a4 4 0 0 1-8 0" stroke="#0f172a" strokeWidth="1.5"/><circle cx="18" cy="10" r="2" stroke="#0f172a" strokeWidth="1.5"/><path d="M18 12v4a4 4 0 0 1-4 4h-2" stroke="#0f172a" strokeWidth="1.5"/></svg>
                  <span>{t('MurmurScreening')}</span>
                </div>
              </div>
              <div className={"vh-collapse "+(openMurmur?"open":"closed")}>
                <>
                  <div><b>{t('Present')}:</b> {adv.extras.murmur?.present ? (lang==='zh'?'是':'Yes') : (lang==='zh'?'否':'No')}</div>
                  <div><b>{t('Phase')}:</b> {adv.extras.murmur?.phase || '—'}</div>
                  <div><b>{t('GradeProxy')}:</b> {adv.extras.murmur?.gradeProxy ?? '—'}</div>
                  <div><b>{t('Confidence')}:</b> {adv.extras.murmur?.confidence!=null ? Math.round(adv.extras.murmur.confidence*100) : '—'}%</div>
                  <div><b>{t('SysCoverage')}:</b> {adv.extras.murmur?.systolic?.coverage!=null ? Math.round(adv.extras.murmur.systolic.coverage*100): '—'}%</div>
                  <div><b>{t('SysShape')}:</b> {adv.extras.murmur?.systolic?.shape || '—'}</div>
                  <div><b>{t('SysPitch')}:</b> {adv.extras.murmur?.systolic?.pitchHz?.toFixed?.(0) || '—'} Hz</div>
                  <div><b>{t('DiaCoverage')}:</b> {adv.extras.murmur?.diastolic?.coverage!=null ? Math.round(adv.extras.murmur.diastolic.coverage*100): '—'}%</div>
                  <div><b>{t('DiaShape')}:</b> {adv.extras.murmur?.diastolic?.shape || '—'}</div>
                  <div><b>{t('DiaPitch')}:</b> {adv.extras.murmur?.diastolic?.pitchHz?.toFixed?.(0) || '—'} Hz</div>
                </>
              </div>
            </div>
            {/* Rhythm */}
            <div style={{ background:'#f8fafc', padding:16, borderRadius:12 }}>
              <div className="vh-sec-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, marginBottom:6 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, fontWeight:600 }}>
                  <div title={openRhythm? t('Collapse') : t('Expand')} className={"vh-arrow "+(openRhythm?"vh-rot":"")} onClick={()=>setOpenRhythm(v=>!v)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
                  </div>
                  {/* heartbeat icon */}
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M3 12h4l2-5 3 10 2-5h5" stroke="#0f172a" strokeWidth="1.5"/><path d="M4 7a5 5 0 0 1 8-1 5 5 0 0 1 8 1c0 7-8 10-8 10S4 14 4 7z" stroke="#0f172a" strokeWidth="1.5"/></svg>
                  <span>{t('RhythmLabel')}</span>
                </div>
              </div>
              <div className={"vh-collapse "+(openRhythm?"open":"closed")}>
                <>
                  <div><b>{t('RRCV')}:</b> {adv.extras.rhythm?.rrCV?.toFixed?.(3) || '—'}</div>
                  <div><b>pNN50:</b> {adv.extras.rhythm?.pNN50?.toFixed?.(2) || '—'}</div>
                  <div><b>{t('SampleEntropy')}:</b> {adv.extras.rhythm?.sampleEntropy?.toFixed?.(2) || '—'}</div>
                  <div><b>{t('PoincareSD12')}:</b> {adv.extras.rhythm?.poincareSD1?.toFixed?.(3) || '—'} / {adv.extras.rhythm?.poincareSD2?.toFixed?.(3) || '—'}</div>
                  <div><b>AF:</b> {adv.extras.rhythm?.afSuspected ? (lang==='zh'?'可疑':'Suspected') : (lang==='zh'?'否':'No')}</div>
                  <div><b>{lang==='zh'?'早搏':'Ectopy'}:</b> {adv.extras.rhythm?.ectopySuspected ? (lang==='zh'?'可疑':'Suspected') : (lang==='zh'?'否':'No')}</div>
                </>
              </div>
            </div>
          </div>
          </div>
        </>
      )}

      {(features || extra) && (
        <>
          <div className="vh-sec-head" style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 6px', display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <div title={openFeatures? t('Collapse') : t('Expand')} className={"vh-arrow "+(openFeatures?"vh-rot":"")} onClick={()=>setOpenFeatures(v=>!v)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
              </div>
              {/* sliders icon */}
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 7h12M4 17h12M16 7v-2M8 17v2M12 12h8M12 12v-2" stroke="#0f172a" strokeWidth="1.5"/></svg>
              <span>{t('Features')}</span>
            </div>
          </div>
          <div className={"vh-collapse "+(openFeatures?"open":"closed")}>
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
          </div>
        </>
      )}

      {/* AI Analysis */}
      <div className="vh-sec-head" style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8, margin:'12px 0 6px' }}>
        <div style={{ fontSize: 18, fontWeight: 600, display:'flex', alignItems:'center', gap:8 }}>
          <div title={openAI? t('Collapse') : t('Expand')} className={"vh-arrow "+(openAI?"vh-rot":"")} onClick={()=>setOpenAI(v=>!v)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#0f172a"><path d="M8 5l8 7-8 7z"/></svg>
          </div>
          {/* sparkles icon */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" stroke="#0f172a" strokeWidth="1.2"/></svg>
          <span>{t('AIAnalysis')}</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {aiText && (
            <button onClick={()=> setChatOpen(true)} className="vh-btn vh-btn-outline" style={{ padding:'6px 10px' }}>
              {t('StartConversation')}
            </button>
          )}
        </div>
      </div>
      <div className={"vh-collapse "+(openAI?"open":"closed")}>
      <div style={{ background:'#f8fafc', padding:16, borderRadius:12 }}>
        {!aiText && (
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
          <button disabled={aiBusy} onClick={async ()=>{
            setAiBusy(true); setAiErr('');
            try{
              const sys = lang==='zh'
                ? '你是一名心血管科医生助手。请基于提供的“临床级PCG指标”和“基础特征”生成一份简洁、可信、可执行的报告，包含：结论、证据与解释、建议（不少于3条，避免夸张医疗承诺）。不要杜撰未给出的测量值。'
                : 'You are a cardiology assistant. Using the provided clinical PCG metrics and basic features, produce a concise, reliable, actionable report with: Conclusion, Evidence & Interpretation, and 3+ concrete Advice items. Do not fabricate measurements not provided.';
              const ctx = [];
              try { if (adv) ctx.push('clinical_pcg:\n```json\n'+JSON.stringify(adv)+'\n```'); } catch {}
              try { if (features) ctx.push('features:\n```json\n'+JSON.stringify(features)+'\n```'); } catch {}
              const messages = [
                { role: 'system', content: sys },
                { role: 'user', content: (lang==='zh'?'以下是分析指标：\n':'Here are the analysis metrics:\n') + ctx.join('\n\n') }
              ];
              const resp = await fetch(LLM_BASE + '/chat', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ messages, temperature: 0.2 }) });
              const j = await resp.json().catch(()=>({}));
              if (!resp.ok || j?.error) throw new Error(j?.error || 'chat failed');
              const text = j?.text || '';
              setAiText(text);
              // Persist to analysis record for this language
              const ts = new Date().toISOString();
              try {
                const sv = await fetch(ANALYSIS_BASE + `/records/${id}/ai`, {
                  method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
                  body: JSON.stringify({ lang, text, model: j?.model || 'llm' })
                });
                const svj = await sv.json().catch(()=>({}));
                if (sv.ok && svj?.ai) {
                  setMeta(m => ({ ...(m||{}), ai: svj.ai, ai_generated_at: svj.ai_generated_at }));
                }
              } catch {}
            }catch(e){ setAiErr((e?.message)||'AI analysis failed'); }
            finally{ setAiBusy(false); }
          }} className="vh-btn vh-btn-primary" style={{ padding:'8px 12px', opacity: aiBusy ? 0.7 : 1, cursor: 'pointer' }}>
            {aiBusy ? t('Analyzing') : t('RunAI')}
          </button>
          {aiErr && <span style={{ color:'#b91c1c', fontSize:13 }}>{aiErr}</span>}
        </div>
        )}
        {/* AI metrics block removed — AI now uses existing metrics in prompt */}
        {aiText && (
          <>
            <div
              style={{ marginTop:12, lineHeight:1.6, color:'#0f172a' }}
              dangerouslySetInnerHTML={{ __html: renderMarkdown(aiText) }}
            />
            <div style={{ marginTop:8, fontSize:12, color:'#64748b' }}>{t('AIGeneratedAt') + ' ' + (meta?.ai_generated_at ? new Date(meta.ai_generated_at).toLocaleString() : '')}</div>
          </>
        )}
      </div>
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
