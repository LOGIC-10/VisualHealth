"use client";
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '../../components/i18n';
import { API } from '../../lib/api';

const AUTH_BASE = API.auth;
const MEDIA_BASE = API.media;
const ANALYSIS_BASE = API.analysis;
const VIZ_BASE = API.viz;

export default function Onboarding(){
  const { t, lang } = useI18n();
  const [token, setToken] = useState('');
  const [me, setMe] = useState(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [devToken, setDevToken] = useState('');
  const [cooldownSec, setCooldownSec] = useState(0);

  async function readJson(resp){
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await resp.json();
    const text = await resp.text();
    const snippet = text.slice(0, 180).replace(/\s+/g, ' ').trim();
    throw new Error(`${resp.status} ${resp.statusText}: ${snippet || 'non-json response'}`);
  }

  // Fields
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [visibilityPreset, setVisibilityPreset] = useState('private');

  useEffect(() => {
    const tkn = typeof localStorage !== 'undefined' ? localStorage.getItem('vh_token') : null;
    if (!tkn) { window.location.href = '/auth'; return; }
    setToken(tkn);
    // If a guest pending analysis exists, save it immediately after login
    (async () => {
      try {
        const raw = localStorage.getItem('vh_pending_analysis');
        if (raw) {
          const p = JSON.parse(raw);
          if (p?.base64 && p?.name && p?.type) {
            const bin = Uint8Array.from(atob(p.base64), c=>c.charCodeAt(0));
            const blob = new Blob([bin], { type: p.type || 'audio/wav' });
            const fd = new FormData(); fd.append('file', new File([blob], p.name, { type: p.type||'application/octet-stream' }));
            // Upload media
            const up = await fetch(MEDIA_BASE + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${tkn}` }, body: fd });
            const meta = await up.json(); if (!up.ok || meta?.error || !meta?.id) throw new Error(meta?.error || 'upload failed');
            // Compute quick features locally to seed record (best-effort)
            let features = null;
            try {
              const arr = await blob.arrayBuffer();
              const Ctx = window.OfflineAudioContext || window.AudioContext || window.webkitAudioContext;
              const ctx = new (Ctx)();
              const buf = await ctx.decodeAudioData(arr.slice(0));
              const ch = buf.getChannelData(0); const targetSR = 8000; const ratio = Math.max(1, Math.floor(buf.sampleRate/targetSR));
              const ds = new Float32Array(Math.ceil(ch.length/ratio)); for (let i=0;i<ds.length;i++) ds[i] = ch[i*ratio]||0;
              const r = await fetch(VIZ_BASE + '/features_pcm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ sampleRate: Math.round(buf.sampleRate/ratio), pcm: Array.from(ds) }) });
              if (r.ok) features = await r.json();
            } catch {}
            // Create analysis record
            const body = { mediaId: meta.id, filename: meta.filename, mimetype: meta.mimetype, size: meta.size, features: features || { sampleRate: null, durationSec: null } };
            const rec = await fetch(ANALYSIS_BASE + '/records', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${tkn}` }, body: JSON.stringify(body) });
            const saved = await rec.json();
            // Clear stash and redirect to detail
            localStorage.removeItem('vh_pending_analysis');
            if (saved?.id) { window.location.href = `/analysis/${saved.id}`; return; }
          }
        }
      } catch {}
    })();
    fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${tkn}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(u => {
        setMe(u);
        setDisplayName(u.display_name || '');
        try { setBirthDate(u.birth_date || ''); } catch {}
        try { setGender(u.gender || ''); } catch {}
        try { setHeightCm(u.height_cm != null ? String(u.height_cm) : ''); } catch {}
        try { setWeightKg(u.weight_kg != null ? String(u.weight_kg) : ''); } catch {}
        try { setVisibilityPreset((u.profile_visibility?.preset)||'private'); } catch {}
        // If user already verified (existing user), skip onboarding
        try {
          const pending = localStorage.getItem('vh_pending_analysis');
          if (u?.email_verified_at && !pending) {
            window.location.href = '/';
          }
        } catch {}
      })
      .catch(() => {});
  }, []);

  const bmi = useMemo(() => {
    const h = parseFloat(heightCm); const w = parseFloat(weightKg);
    if (!h || !w || h <= 0) return null;
    const m = h / 100.0; return (w / (m*m));
  }, [heightCm, weightKg]);

  const steps = [
    // Email verification with OTP code step
    {
      key: 'verify',
      title: t('VerifyEmail'),
      content: (
        <div style={{ display:'grid', gap:12 }}>
          <div>{me?.email} · {me?.email_verified_at ? (lang==='zh'?'已验证':'Verified') : (lang==='zh'?'未验证':'Unverified')}</div>
          {!me?.email_verified_at && (
            <>
              <div style={{ color:'#64748b' }}>{t('CodeSentHint')||'We have sent a 6-digit verification code to your email. Enter it below to continue.'}</div>
              <form onSubmit={async(e)=>{ e.preventDefault(); if (busy) return; const code = e.currentTarget.elements.code?.value?.trim(); if (!code) return; setBusy(true); setErr(''); setOk('');
                try {
                  const resp = await fetch(AUTH_BASE + '/email/verify', { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ token: code }) });
                  const j = await readJson(resp); if (!resp.ok || j?.error) throw new Error(j?.error||'verify failed');
                  setOk(t('EmailVerifiedOk'));
                  // refresh user to reflect verified status
                  const r2 = await fetch(AUTH_BASE + '/me', { headers: { Authorization:`Bearer ${token}` } }); const u2 = await r2.json(); if (r2.ok) setMe(u2);
                } catch(e){ setErr(e?.message || 'verify failed'); } finally { setBusy(false); }
              }} style={{ display:'flex', gap:8, alignItems:'center' }}>
                <input name="code" inputMode="numeric" pattern="[0-9]*" maxLength={6} placeholder={t('EnterCode')||'Enter code'} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                <button disabled={busy} className="vh-btn vh-btn-primary">{t('Verify')}</button>
                <button
                  disabled={busy || cooldownSec>0}
                  className="vh-btn vh-btn-outline"
                  onClick={async()=>{
                  setErr(''); setOk(''); setDevToken(''); setBusy(true);
                  try {
                    const resp = await fetch(AUTH_BASE + '/email/send_verification', { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json', Authorization:`Bearer ${token}` } });
                    const j = await readJson(resp);
                    if (resp.status === 429 && (j?.error === 'cooldown')) {
                      const sec = Math.max(1, Math.floor(j?.retrySec || 60));
                      setCooldownSec(sec);
                    } else if (!resp.ok || j?.error) {
                      throw new Error(j?.error || 'send failed');
                    } else {
                      setOk(t('VerificationEmailSent'));
                      if (j?.devToken) setDevToken(j.devToken);
                      setCooldownSec(60);
                    }
                  } catch(e){ setErr(e?.message || 'send failed'); } finally { setBusy(false); }
                }}>
                  {cooldownSec>0 ? `${t('ResendCode')||'Resend code'} (${cooldownSec}s)` : (t('ResendCode')||'Resend code')}
                </button>
                {devToken && <span style={{ color:'#334155', fontSize:12 }}>DEV: <code>{devToken}</code></span>}
              </form>
            </>
          )}
          {ok && <div style={{ color:'#166534' }}>{ok}</div>}
          {err && <div style={{ color:'#b91c1c' }}>{err}</div>}
        </div>
      )
    },
    // Basic profile
    {
      key: 'basic',
      title: t('ProfileTitle'),
      content: (
        <div style={{ display:'grid', gap:12 }}>
          <div>
            <div style={{ fontSize:12, color:'#64748b' }}>{t('DisplayName')}</div>
            <input value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder={t('DisplayName')} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#64748b' }}>{t('BirthDate')}</div>
            <input type="date" value={birthDate} onChange={e=>setBirthDate(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#64748b' }}>{t('Gender')}</div>
            <select value={gender} onChange={e=>setGender(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }}>
              <option value="">—</option>
              <option value="male">{t('Male')}</option>
              <option value="female">{t('Female')}</option>
              <option value="other">{t('Other')}</option>
              <option value="prefer_not_say">{t('PreferNotSay')}</option>
            </select>
          </div>
        </div>
      )
    },
    // Body
    {
      key: 'body',
      title: t('BMI'),
      content: (
        <div style={{ display:'grid', gap:12 }}>
          <div>
            <div style={{ fontSize:12, color:'#64748b' }}>{t('HeightCm')}</div>
            <input type="number" min={0} max={300} value={heightCm} onChange={e=>setHeightCm(e.target.value)} placeholder="170" style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
          </div>
          <div>
            <div style={{ fontSize:12, color:'#64748b' }}>{t('WeightKg')}</div>
            <input type="number" min={0} max={500} value={weightKg} onChange={e=>setWeightKg(e.target.value)} placeholder="65" style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
          </div>
          <div style={{ color:'#64748b' }}>{t('BMI')}: {bmi ? bmi.toFixed(1) : '—'}</div>
        </div>
      )
    },
    // Visibility
    {
      key: 'privacy',
      title: t('PrivacyTitle')||'Privacy',
      content: (
        <div style={{ display:'grid', gap:12 }}>
          <div style={{ fontSize:12, color:'#64748b' }}>{t('VisibilityPreset')||'Visibility preset'}</div>
          <select value={visibilityPreset} onChange={e=>setVisibilityPreset(e.target.value)} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }}>
            <option value="private">{t('Private')||'Private'}</option>
            <option value="doctor">{t('DoctorOnly')||'Doctor only'}</option>
            <option value="public">{t('Public')||'Public'}</option>
          </select>
        </div>
      )
    }
  ];

  async function saveStep(){
    if (!token) return;
    if (step === 0 && !me?.email_verified_at) { setErr(t('PleaseVerifyEmailFirst')||'Please verify email first'); return; }
    setBusy(true); setErr(''); setOk('');
    try {
      const body = {};
      if (step === 1) Object.assign(body, { displayName, birthDate, gender });
      if (step === 2) Object.assign(body, { heightCm: heightCm? Number(heightCm): null, weightKg: weightKg? Number(weightKg): null });
      if (step === 3) Object.assign(body, { visibility: { preset: visibilityPreset, fields: {} } });
      if (Object.keys(body).length) {
        const resp = await fetch(AUTH_BASE + '/me', { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify(body) });
        const j = await resp.json(); if (!resp.ok || j?.error) throw new Error(j?.error || 'update failed');
        setMe(j);
      }
      setStep(s => Math.min(steps.length - 1, s + 1));
    } catch(e){ setErr(e?.message || 'update failed'); } finally { setBusy(false); }
  }

  // Auto-send verification code when step 0 is active and not verified
  useEffect(() => {
    if (!token || step !== 0) return;
    if (me?.email_verified_at) return;
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch(AUTH_BASE + '/email/send_verification', { method:'POST', headers:{ 'Content-Type':'application/json', 'Accept':'application/json', Authorization:`Bearer ${token}` } });
        const j = await readJson(resp);
        if (!cancelled) {
          if (resp.status === 429 && (j?.error === 'cooldown')) {
            const sec = Math.max(1, Math.floor(j?.retrySec || 60));
            setCooldownSec(sec);
          } else if (!resp.ok || j?.error) {
            throw new Error(j?.error || 'send failed');
          } else {
            setOk(t('VerificationEmailSent'));
            if (j?.devToken) setDevToken(j.devToken);
            setCooldownSec(60);
          }
        }
      } catch(e) { if (!cancelled) setErr(e?.message || 'send failed'); }
    })();
    return () => { cancelled = true; };
  }, [token, step, me?.email_verified_at]);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const id = setInterval(() => setCooldownSec(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldownSec]);

  return (
    <div style={{ maxWidth: 680, margin:'24px auto', padding:'0 24px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
        <div style={{ fontSize:22, fontWeight:600 }}>{t('Onboarding')||'Welcome'}</div>
        <Link href="/" className="vh-btn vh-btn-outline">{t('Skip')||'Skip'}</Link>
      </div>
      <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16 }}>
        <div style={{ fontSize:18, fontWeight:600, marginBottom:8 }}>{steps[step].title}</div>
        <div>{steps[step].content}</div>
        {err && <div style={{ color:'#b91c1c', marginTop:8 }}>{err}</div>}
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:12 }}>
          {step < steps.length - 1 ? (
            <button onClick={saveStep} disabled={busy} className="vh-btn vh-btn-primary">{t('Next')||'Next'}</button>
          ) : (
            <Link href="/" className="vh-btn vh-btn-primary">{t('Finish')||'Finish'}</Link>
          )}
        </div>
      </div>
    </div>
  );
}
