"use client";

import { API } from './api';

const ANALYSIS_BASE = API.analysis;
const VIZ_BASE = API.viz;

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

async function blobToBase64(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  return arrayBufferToBase64(arrayBuffer);
}

export async function runLocalAnalysis(file, { useHsmm = false } = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const audioCtxCtor = window.AudioContext || window.webkitAudioContext;
  if (!audioCtxCtor) {
    throw new Error('AudioContext not supported');
  }
  const audioCtx = new audioCtxCtor();
  let audioBuf;
  try {
    audioBuf = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    try { await audioCtx.close(); } catch {}
  }

  const channel = audioBuf.getChannelData(0);
  const targetSR = 8000;
  const ratio = Math.max(1, Math.floor(audioBuf.sampleRate / targetSR));
  const downsampled = new Float32Array(Math.ceil(channel.length / ratio));
  for (let i = 0; i < downsampled.length; i++) {
    downsampled[i] = channel[i * ratio] || 0;
  }

  const payload = {
    sampleRate: Math.round(audioBuf.sampleRate / ratio),
    pcm: Array.from(downsampled)
  };

  const featuresResp = await fetch(ANALYSIS_BASE + '/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!featuresResp.ok) {
    const errText = await featuresResp.text().catch(() => '');
    throw new Error(errText || 'analysis failed');
  }
  const features = await featuresResp.json();

  let quality = null;
  try {
    const qResp = await fetch(VIZ_BASE + '/pcg_quality_pcm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (qResp.ok) {
      quality = await qResp.json();
    }
  } catch {}

  if (quality && (!quality.isHeart || !quality.qualityOk)) {
    return {
      ok: false,
      reason: 'quality',
      features,
      quality,
      payload,
      durationSec: audioBuf.duration,
      arrayBuffer
    };
  }

  const [advResp, specResp, extraResp] = await Promise.all([
    fetch(VIZ_BASE + '/pcg_advanced', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, useHsmm })
    }).catch(() => null),
    fetch(VIZ_BASE + '/spectrogram_pcm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, maxFreq: 2000, width: 1200, height: 320 })
    }).catch(() => null),
    fetch(VIZ_BASE + '/features_pcm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => null)
  ]);

  let adv = null;
  if (advResp && advResp.ok) {
    try { adv = await advResp.json(); } catch {}
  }

  let specBlob = null;
  let specBase64 = null;
  if (specResp && specResp.ok) {
    try {
      specBlob = await specResp.blob();
      specBase64 = await blobToBase64(specBlob);
    } catch {}
  }

  let extra = null;
  if (extraResp && extraResp.ok) {
    try { extra = await extraResp.json(); } catch {}
  }

  const mime = file.type || 'audio/wav';
  const audioBase64 = arrayBufferToBase64(arrayBuffer);
  return {
    ok: true,
    features,
    quality,
    adv,
    extra,
    payload,
    specBlob,
    specBase64,
    durationSec: audioBuf.duration,
    audioBase64,
    audioDataUrl: `data:${mime};base64,${audioBase64}`,
    mime,
    arrayBuffer
  };
}

export function base64ToBlob(b64, mime = 'application/octet-stream') {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export function base64ToObjectUrl(b64, mime = 'application/octet-stream') {
  if (!b64) return null;
  const blob = base64ToBlob(b64, mime);
  return URL.createObjectURL(blob);
}

export function revokeObjectUrl(url) {
  if (!url) return;
  try { URL.revokeObjectURL(url); } catch {}
}
