"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';
import { API } from '../../lib/api';

const AUTH_BASE = API.auth;
const MEDIA_BASE = API.media;

export default function SettingsPage() {
  const { t, lang } = useI18n();
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);

  // Editable fields
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [avatarId, setAvatarId] = useState(null);
  const [copyHint, setCopyHint] = useState('');
  const [okHint, setOkHint] = useState('');
  const fileInputRef = useRef(null);
  const [avatarViewOpen, setAvatarViewOpen] = useState(false);
  const [avatarEditOpen, setAvatarEditOpen] = useState(false);
  const [cropSrc, setCropSrc] = useState('');
  const [cropZoom, setCropZoom] = useState(1);
  const [cropDx, setCropDx] = useState(0);
  const [cropDy, setCropDy] = useState(0);
  const cropImgRef = useRef(null);
  const cropDragRef = useRef({ active:false, x:0, y:0 });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [editingBasic, setEditingBasic] = useState(false);
  const [editingMedical, setEditingMedical] = useState(false);
  const [birthDateErr, setBirthDateErr] = useState('');
  const [editingVitals, setEditingVitals] = useState(false);
  const [editingHistory, setEditingHistory] = useState(false);
  const [editingLifestyle, setEditingLifestyle] = useState(false);
  // Privacy & extras
  const [visibility, setVisibility] = useState({ preset: 'private', fields: {} }); // fields: key -> 'private'|'doctor'|'public'
  // Units
  const [unitHeight, setUnitHeight] = useState('cm'); // 'cm' | 'in'
  const [unitWeight, setUnitWeight] = useState('kg'); // 'kg' | 'lb'
  // Health extras
  const [vitals, setVitals] = useState({ hr: '', sys: '', dia: '', spo2: '', bodyFat: '', waist: '' });
  const [history, setHistory] = useState({ past: '', surgeries: '', family: '', meds: '', allergies: '' });
  const [lifestyle, setLifestyle] = useState({ smoking: '', alcohol: '', exercise: '', sleepHours: '' });
  // Security
  const [pwdCur, setPwdCur] = useState('');
  const [pwdNew, setPwdNew] = useState('');

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    setToken(t);
    if (!t) return;
    fetch(AUTH_BASE + '/me', { headers: { Authorization: `Bearer ${t}` } })
      .then(async r => {
        if (!r.ok) throw new Error('me failed');
        const u = await r.json();
        if (u?.error) throw new Error(u.error);
        setUser(u);
        setDisplayName(u.display_name || '');
        setPhone(u.phone || '');
        setBirthDate(u.birth_date || '');
        setGender(u.gender || '');
        setHeightCm(u.height_cm != null ? String(u.height_cm) : '');
        setWeightKg(u.weight_kg != null ? String(u.weight_kg) : '');
        setAvatarId(u.avatar_media_id || null);
        // Privacy
        try { setVisibility(v => ({ preset: (u.profile_visibility?.preset)||'private', fields: (u.profile_visibility?.fields)||{} })); } catch {}
        // Extras
        const ex = u.profile_extras || {};
        if (ex.vitals) setVitals({
          hr: ex.vitals.hr!=null? String(ex.vitals.hr):'',
          sys: ex.vitals.sys!=null? String(ex.vitals.sys):'',
          dia: ex.vitals.dia!=null? String(ex.vitals.dia):'',
          spo2: ex.vitals.spo2!=null? String(ex.vitals.spo2):'',
          bodyFat: ex.vitals.bodyFat!=null? String(ex.vitals.bodyFat):'',
          waist: ex.vitals.waist!=null? String(ex.vitals.waist):'',
        });
        if (ex.history) setHistory({
          past: ex.history.past||'', surgeries: ex.history.surgeries||'', family: ex.history.family||'', meds: ex.history.meds||'', allergies: ex.history.allergies||''
        });
        if (ex.lifestyle) setLifestyle({
          smoking: ex.lifestyle.smoking||'', alcohol: ex.lifestyle.alcohol||'', exercise: ex.lifestyle.exercise||'', sleepHours: ex.lifestyle.sleepHours!=null? String(ex.lifestyle.sleepHours):''
        });
      })
      .catch(() => {});
  }, []);

  const canChangeName = useMemo(() => {
    if (!user?.next_allowed_display_name_change_at) return true;
    try { return new Date() >= new Date(user.next_allowed_display_name_change_at); } catch { return true; }
  }, [user]);

  const bmi = useMemo(() => {
    const h = parseFloat(heightCm); const w = parseFloat(weightKg);
    if (!h || !w) return '';
    const m = h / 100.0; const val = w / (m * m);
    return isFinite(val) ? val.toFixed(1) : '';
  }, [heightCm, weightKg]);

  const completenessPct = useMemo(() => {
    let filled = 0; const total = 12;
    if (displayName) filled++; if (phone) filled++; if (birthDate) filled++; if (gender) filled++; if (heightCm) filled++; if (weightKg) filled++;
    if (vitals.hr) filled++; if (vitals.sys && vitals.dia) filled++; if (vitals.spo2) filled++; if (vitals.bodyFat) filled++; if (vitals.waist) filled++;
    return Math.min(100, Math.round((filled/total)*100));
  }, [displayName, phone, birthDate, gender, heightCm, weightKg, vitals]);

  function formatLocalDate(v){
    if (!v) return '—';
    try { const d = new Date(v); if (isNaN(d.getTime())) return String(v); return d.toLocaleDateString(); } catch { return String(v); }
  }
  function calcAgeYears(v){
    try { const d = new Date(v); if (isNaN(d.getTime())) return null; const now = new Date(); let age = now.getFullYear() - d.getFullYear(); const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--; return age>=0?age:null; } catch { return null; }
  }

  async function onSave() {
    if (!token) return;
    setSaving(true); setErr('');
    try {
      // Build PATCH body only with changed fields to avoid side effects (e.g., nickname cooldown)
      const body = {};
      // Track local patch fallback to ensure UI reflects change even if server echo is partial
      const localPatch = {};
      const dn = (displayName || '').trim();
      if (typeof user?.display_name === 'undefined' || dn !== (user?.display_name || '')) { body.displayName = dn; localPatch.display_name = dn; }
      const ph = (phone || '').trim();
      if (ph !== (user?.phone || '')) { body.phone = ph || null; localPatch.phone = ph || ''; }
      const birthChanged = (birthDate || '') !== (user?.birth_date || '');
      if (birthChanged) { body.birthDate = birthDate || null; localPatch.birth_date = birthDate || ''; }
      if ((gender || '') !== (user?.gender || '')) { body.gender = gender || null; localPatch.gender = gender || ''; }
      const hVal = heightCm ? parseInt(heightCm, 10) : null;
      const hCur = (user?.height_cm != null ? Number(user.height_cm) : null);
      if (hVal !== hCur) { body.heightCm = hVal; localPatch.height_cm = (hVal != null ? hVal : null); }
      const wVal = weightKg ? parseFloat(weightKg) : null;
      const wCur = (user?.weight_kg != null ? Number(user.weight_kg) : null);
      if (wVal !== wCur) { body.weightKg = wVal; localPatch.weight_kg = (wVal != null ? wVal : null); }
      const aCur = user?.avatar_media_id || null;
      if ((avatarId || null) !== aCur) { body.avatarMediaId = avatarId || null; localPatch.avatar_media_id = (avatarId || null); }

      // Validate birth date only if it is being saved/changed
      if ('birthDate' in body && body.birthDate) {
        const bd = new Date(body.birthDate); const now = new Date();
        if (isNaN(bd.getTime()) || bd > now) { setBirthDateErr(lang==='zh' ? '出生日期不能晚于今天' : 'Birth date cannot be in the future'); return false; }
      } else { setBirthDateErr(''); }

      // Attach visibility/extras always for consistency
      body.visibility = visibility;
      const extras = {
        vitals: {
          hr: vitals.hr? Number(vitals.hr) : null,
          sys: vitals.sys? Number(vitals.sys) : null,
          dia: vitals.dia? Number(vitals.dia) : null,
          spo2: vitals.spo2? Number(vitals.spo2) : null,
          bodyFat: vitals.bodyFat? Number(vitals.bodyFat) : null,
          waist: vitals.waist? Number(vitals.waist) : null,
        },
        history: { past: history.past||'', surgeries: history.surgeries||'', family: history.family||'', meds: history.meds||'', allergies: history.allergies||'' },
        lifestyle: { smoking: lifestyle.smoking||'', alcohol: lifestyle.alcohol||'', exercise: lifestyle.exercise||'', sleepHours: lifestyle.sleepHours? Number(lifestyle.sleepHours): null },
      };
      body.extras = extras;

      const r = await fetch(AUTH_BASE + '/me', { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || j?.error) {
        if (r.status === 429) {
          const when = j?.nextAllowedAt ? new Date(j.nextAllowedAt).toLocaleString() : '';
          setErr(lang==='zh' ? `昵称修改过于频繁，可在 ${when} 后再次修改` : `Nickname recently changed. Try again after ${when}.`);
        } else {
          setErr(j?.error || 'save failed');
        }
        return false;
      }
      setBirthDateErr('');
      // Merge server echo if provided; otherwise fall back to localPatch so UI reflects saved data immediately
      const merged = (function(){
        const base = { ...(user || {}) };
        return { ...base, ...localPatch, ...(j && j.id ? j : {}) };
      })();
      setUser(merged);
      try { window.dispatchEvent(new CustomEvent('vh_user_change', { detail: merged })); } catch {}
      // Sync extras visibility states from server echo if present
      try { if (j.profile_visibility) setVisibility({ preset: j.profile_visibility.preset||'private', fields: j.profile_visibility.fields||{} }); } catch {}
      try {
        const ex = j.profile_extras || {};
        if (ex.vitals) setVitals({ hr: ex.vitals.hr!=null? String(ex.vitals.hr):'', sys: ex.vitals.sys!=null? String(ex.vitals.sys):'', dia: ex.vitals.dia!=null? String(ex.vitals.dia):'', spo2: ex.vitals.spo2!=null? String(ex.vitals.spo2):'', bodyFat: ex.vitals.bodyFat!=null? String(ex.vitals.bodyFat):'', waist: ex.vitals.waist!=null? String(ex.vitals.waist):'' });
        if (ex.history) setHistory({ past: ex.history.past||'', surgeries: ex.history.surgeries||'', family: ex.history.family||'', meds: ex.history.meds||'', allergies: ex.history.allergies||'' });
        if (ex.lifestyle) setLifestyle({ smoking: ex.lifestyle.smoking||'', alcohol: ex.lifestyle.alcohol||'', exercise: ex.lifestyle.exercise||'', sleepHours: ex.lifestyle.sleepHours!=null? String(ex.lifestyle.sleepHours):'' });
      } catch {}
      // Sync local form states with server echo; if missing, use localPatch
      const nextDisplay = (Object.prototype.hasOwnProperty.call(j, 'display_name') ? j.display_name : localPatch.display_name);
      if (typeof nextDisplay !== 'undefined' && nextDisplay != null) setDisplayName(nextDisplay);
      const nextPhone = (Object.prototype.hasOwnProperty.call(j, 'phone') ? (j.phone || '') : (typeof localPatch.phone !== 'undefined' ? (localPatch.phone || '') : undefined));
      if (typeof nextPhone !== 'undefined') setPhone(nextPhone);
      const nextBirth = (Object.prototype.hasOwnProperty.call(j, 'birth_date') ? (j.birth_date || '') : (typeof localPatch.birth_date !== 'undefined' ? (localPatch.birth_date || '') : undefined));
      if (typeof nextBirth !== 'undefined') setBirthDate(nextBirth);
      const nextGender = (Object.prototype.hasOwnProperty.call(j, 'gender') ? (j.gender || '') : (typeof localPatch.gender !== 'undefined' ? (localPatch.gender || '') : undefined));
      if (typeof nextGender !== 'undefined') setGender(nextGender);
      const nextH = (Object.prototype.hasOwnProperty.call(j, 'height_cm') ? (j.height_cm != null ? String(j.height_cm) : '') : (Object.prototype.hasOwnProperty.call(localPatch,'height_cm') ? (localPatch.height_cm != null ? String(localPatch.height_cm) : '') : undefined));
      if (typeof nextH !== 'undefined') setHeightCm(nextH);
      const nextW = (Object.prototype.hasOwnProperty.call(j, 'weight_kg') ? (j.weight_kg != null ? String(j.weight_kg) : '') : (Object.prototype.hasOwnProperty.call(localPatch,'weight_kg') ? (localPatch.weight_kg != null ? String(localPatch.weight_kg) : '') : undefined));
      if (typeof nextW !== 'undefined') setWeightKg(nextW);
      setOkHint(lang==='zh' ? '已保存' : 'Saved');
      setTimeout(()=>setOkHint(''), 1200);
      // Skip post-save refresh to avoid overwriting with stale/error payloads
      return true;
    } finally { setSaving(false); }
  }

  async function onSaveBasic(){
    const ok = await onSave();
    if (ok) setEditingBasic(false);
  }

  async function onSaveMedical(){
    const ok = await onSave();
    if (ok) setEditingMedical(false);
  }

  async function onSaveVitals(){ const ok = await onSave(); if (ok) setEditingVitals(false); }
  async function onSaveHistory(){ const ok = await onSave(); if (ok) setEditingHistory(false); }
  async function onSaveLifestyle(){ const ok = await onSave(); if (ok) setEditingLifestyle(false); }

  function resetFromUser(){
    if (!user) return;
    const ex = user.profile_extras || {};
    setVitals({
      hr: ex?.vitals?.hr!=null? String(ex.vitals.hr):'',
      sys: ex?.vitals?.sys!=null? String(ex.vitals.sys):'',
      dia: ex?.vitals?.dia!=null? String(ex.vitals.dia):'',
      spo2: ex?.vitals?.spo2!=null? String(ex.vitals.spo2):'',
      bodyFat: ex?.vitals?.bodyFat!=null? String(ex.vitals.bodyFat):'',
      waist: ex?.vitals?.waist!=null? String(ex.vitals.waist):'',
    });
    setHistory({
      past: ex?.history?.past||'', surgeries: ex?.history?.surgeries||'', family: ex?.history?.family||'', meds: ex?.history?.meds||'', allergies: ex?.history?.allergies||''
    });
    setLifestyle({
      smoking: ex?.lifestyle?.smoking||'', alcohol: ex?.lifestyle?.alcohol||'', exercise: ex?.lifestyle?.exercise||'', sleepHours: ex?.lifestyle?.sleepHours!=null? String(ex.lifestyle.sleepHours):''
    });
  }

  function labelGender(v){
    if (!v) return '—';
    if (v==='male') return t('Male');
    if (v==='female') return t('Female');
    if (v==='other') return t('Other');
    if (v==='prefer_not') return t('PreferNotSay');
    return v;
  }

  async function onPickAvatar(e) {
    const f = (e.target.files || [])[0]; if (!f) return;
    try {
      const reader = new FileReader();
      reader.onload = () => { setCropSrc(String(reader.result||'')); setCropZoom(1); setCropDx(0); setCropDy(0); setAvatarEditOpen(true); };
      reader.readAsDataURL(f);
    } catch {}
    finally { try { e.target.value = ''; } catch {} }
  }

  function onCropMouseDown(e){ cropDragRef.current = { active:true, x:e.clientX, y:e.clientY }; }
  function onCropMouseMove(e){ if(!cropDragRef.current.active) return; const dx=e.clientX-cropDragRef.current.x; const dy=e.clientY-cropDragRef.current.y; cropDragRef.current.x=e.clientX; cropDragRef.current.y=e.clientY; setCropDx(v=>v+dx); setCropDy(v=>v+dy); }
  function onCropMouseUp(){ cropDragRef.current.active=false; }

  // Unit helpers
  const heightDisplay = useMemo(() => {
    if (!heightCm) return '';
    const cm = Number(heightCm); if (!isFinite(cm)) return '';
    return unitHeight==='cm' ? String(cm) : String(Math.round(cm / 2.54));
  }, [heightCm, unitHeight]);
  const weightDisplay = useMemo(() => {
    if (!weightKg) return '';
    const kg = Number(weightKg); if (!isFinite(kg)) return '';
    return unitWeight==='kg' ? String(kg) : String(Math.round(kg * 2.20462));
  }, [weightKg, unitWeight]);
  function onHeightInput(v){
    const s = String(v||'').trim(); if (!s) { setHeightCm(''); return; }
    const n = parseFloat(s); if (!isFinite(n)) return;
    if (unitHeight==='cm') setHeightCm(String(Math.max(0, Math.min(300, Math.round(n)))));
    else setHeightCm(String(Math.max(0, Math.min(300, Math.round(n * 2.54)))));
  }
  function onWeightInput(v){
    const s = String(v||'').trim(); if (!s) { setWeightKg(''); return; }
    const n = parseFloat(s); if (!isFinite(n)) return;
    if (unitWeight==='kg') setWeightKg(String(Math.max(0, Math.min(500, Number(n)))));
    else setWeightKg(String(Math.max(0, Math.min(500, Number((n / 2.20462).toFixed(1))))));
  }

  async function saveCroppedAvatar(){
    if (!cropSrc || !token) { setAvatarEditOpen(false); return; }
    try {
      // draw to canvas 512x512
      const img = new Image();
      const blobUrl = cropSrc;
      await new Promise((resolve)=>{ img.onload=resolve; img.src=blobUrl; });
      const CAN = 512; const canvas = document.createElement('canvas'); canvas.width=CAN; canvas.height=CAN; const ctx=canvas.getContext('2d');
      // compute scale to cover canvas, then apply zoom
      const baseScale = Math.max(CAN / img.width, CAN / img.height);
      const scale = baseScale * (cropZoom || 1);
      const drawW = img.width * scale; const drawH = img.height * scale;
      const dx = (CAN - drawW)/2 + cropDx; const dy = (CAN - drawH)/2 + cropDy;
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,CAN,CAN);
      ctx.drawImage(img, dx, dy, drawW, drawH);
      const blob = await new Promise(res => canvas.toBlob(b => res(b), 'image/png', 0.95));
      if (!blob) throw new Error('crop failed');
      const fd = new FormData(); fd.append('file', new File([blob], 'avatar.png', { type:'image/png' })); fd.append('public','true');
      const r = await fetch(MEDIA_BASE + '/upload', { method:'POST', headers:{ Authorization:`Bearer ${token}` }, body: fd });
      const j = await r.json();
      if (j?.id) {
        setAvatarId(j.id);
        // Patch only avatar, preserve other user fields by merging
        const rr = await fetch(AUTH_BASE + '/me', { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ avatarMediaId: j.id }) });
        const ju = await rr.json();
        if (rr.ok) {
          setUser(u => {
            const merged = { ...(u||{}), ...ju };
            if ((ju == null || typeof ju.display_name === 'undefined' || ju.display_name == null) && u && typeof u.display_name !== 'undefined') {
              merged.display_name = u.display_name;
            }
            try { window.dispatchEvent(new CustomEvent('vh_user_change', { detail: merged })); } catch {}
            return merged;
          });
          setOkHint(lang==='zh' ? '头像已更新' : 'Avatar updated'); setTimeout(()=>setOkHint(''), 1200);
        }
      }
    } catch(e){ setErr(e?.message||'avatar failed'); }
    finally { setAvatarEditOpen(false); }
  }

  function copyId(){
    try { navigator.clipboard.writeText(user?.id || ''); setCopyHint(t('Copied')); setTimeout(()=>setCopyHint(''), 1200); } catch {}
  }

  if (!token) return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <div>{t('PleaseLoginManage')}</div>
    </div>
  );

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, marginBottom:12 }}>
        <h1 style={{ fontSize: 28 }}>{t('ProfileTitle')}</h1>
        <div style={{ display:'flex', alignItems:'center', gap:16 }}>
          <div style={{ minWidth:220 }}>
            <div style={{ fontSize:12, color:'#64748b', textAlign:'right' }}>{lang==='zh'?'资料完善度':'Completeness'}: {completenessPct}%</div>
            <div style={{ width:'100%', height:8, background:'#f1f5f9', borderRadius:9999, overflow:'hidden' }}>
              <div style={{ width:`${completenessPct}%`, height:'100%', background:'#2563eb' }} />
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <span style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'隐私设置':'Privacy'}:</span>
            <select value={visibility.preset} onChange={e=>{ const p=e.target.value; setVisibility(v=>({ preset:p, fields: Object.fromEntries(Object.keys(v.fields||{}).map(k=>[k,p])) })); }} style={{ padding:'6px 8px', border:'1px solid #e5e7eb', borderRadius:8 }}>
              <option value="private">{lang==='zh'?'仅自己':'Only me'}</option>
              <option value="doctor">{lang==='zh'?'医生':'Doctor'}</option>
              <option value="public">{lang==='zh'?'公开':'Public'}</option>
            </select>
          </div>
        </div>
      </div>
      {!user && <div>{t('Loading')}</div>}
      {user && (
        <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16, display:'grid', gap:16 }}>
          {/* Account card */}
          <div style={{ background:'transparent', border:'none', borderRadius:0, padding:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              {/* Avatar */}
              <div style={{ position:'relative' }}>
                <div onClick={()=>{ if(avatarId) setAvatarViewOpen(true); }} title={t('ViewAvatar')} style={{ position:'relative', width:72, height:72, borderRadius:'9999px', overflow:'hidden', cursor: avatarId?'zoom-in':'pointer', border:'1px solid #e5e7eb' }}>
                  {avatarId ? (
                    <img src={`${MEDIA_BASE}/file/${avatarId}`} alt="avatar" style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
                  ) : (
                    <div style={{ width:'100%', height:'100%', background:'#0f172a', color:'#fff', display:'grid', placeItems:'center', fontSize:24 }}>
                      {(user.display_name || user.email || 'U').trim()[0]?.toUpperCase?.() || 'U'}
                    </div>
                  )}
                  {/* Small camera button to change */}
                  <button onClick={(e)=>{ e.stopPropagation(); fileInputRef.current?.click(); }} title={t('ChangeAvatar')} style={{ position:'absolute', right:2, bottom:2, width:22, height:22, borderRadius:9999, background:'rgba(0,0,0,0.6)', color:'#fff', display:'grid', placeItems:'center', fontSize:12, border:'none', cursor:'pointer' }}>📷</button>
                </div>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={onPickAvatar} style={{ display:'none' }} />
              </div>
              <div style={{ flex:1 }}>
                <div style={{ display:'grid', gridTemplateColumns:'1fr auto', gap:8, alignItems:'center' }}>
                  <div>
                    <div style={{ fontWeight:700, fontSize:18 }}>{user.display_name || '—'}</div>
                    <div style={{ color:'#64748b', fontSize:13 }}>{user.email}</div>
                  </div>
                  <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                    <div style={{ fontSize:12, color:'#64748b' }}>{t('UserId')}:</div>
                    <div style={{ fontSize:12, color:'#94a3b8' }}>{user.id}</div>
                    <button onClick={copyId} title={t('Copy')} style={{ border:'none', background:'transparent', cursor:'pointer', color:'#64748b' }}>📋</button>
                    {copyHint && <span style={{ color:'#16a34a', fontSize:12 }}>{copyHint}</span>}
                  </div>
                </div>
              </div>
            </div>
          </div>

          

          {/* Basic info card (view/edit toggle) */}
          <div style={{ background:'transparent', border:'none', borderRadius:0, padding:0, position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:12, display:'flex', gap:12 }}>
              {!editingBasic ? (
                <button onClick={()=>{ setEditingBasic(true); setErr(''); setOkHint(''); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <>
                  <button onClick={onSaveBasic} disabled={saving} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Save')}</button>
                  <button onClick={()=>{ setDisplayName(user.display_name||''); setPhone(user.phone||''); setEditingBasic(false); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Cancel')}</button>
                </>
              )}
            </div>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'基本信息':'Basic Info'}</div>
            {!editingBasic ? (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('DisplayName')}</div><div>{user.display_name || '—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('Phone')}</div><div>{user.phone || '—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('Email')}</div><div>{user.email}</div></div>
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('DisplayName')}</div>
                  <input value={displayName} onChange={e=>setDisplayName(e.target.value)} disabled={!canChangeName}
                    placeholder={t('DisplayName')} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                  {!canChangeName && (
                    <div style={{ marginTop:4, fontSize:12, color:'#64748b' }}>
                      {t('NextNameChangeAt')}: {user.next_allowed_display_name_change_at ? new Date(user.next_allowed_display_name_change_at).toLocaleString() : ''}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('Phone')}</div>
                  <input value={phone} onChange={e=>setPhone(e.target.value)} placeholder={t('Phone')} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                </div>
              </div>
            )}
            
          </div>

          {/* Medical info card (view/edit toggle) */}
          <div style={{ background:'transparent', border:'none', borderRadius:0, padding:0, position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:12, display:'flex', gap:12 }}>
              {!editingMedical ? (
                <button onClick={()=>{ setEditingMedical(true); setErr(''); setOkHint(''); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <>
                  <button onClick={onSaveMedical} disabled={saving} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Save')}</button>
                  <button onClick={()=>{ setBirthDate(user.birth_date||''); setGender(user.gender||''); setHeightCm(user.height_cm!=null?String(user.height_cm):''); setWeightKg(user.weight_kg!=null?String(user.weight_kg):''); setEditingMedical(false); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Cancel')}</button>
                </>
              )}
            </div>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'医疗相关':'Medical'}</div>
            {!editingMedical ? (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('BirthDate')}</div><div>{formatLocalDate(user.birth_date)}{calcAgeYears(user.birth_date)!=null ? ` · ${calcAgeYears(user.birth_date)}${lang==='zh'?'岁':'y'}` : ''}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('Gender')}</div><div>{labelGender(user.gender)}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('HeightCm')}</div><div>{user.height_cm!=null? `${user.height_cm} cm`:'—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('WeightKg')}</div><div>{user.weight_kg!=null? `${user.weight_kg} kg`:'—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('BMI')}</div><div>{(user.height_cm && user.weight_kg)? (user.weight_kg/Math.pow(user.height_cm/100,2)).toFixed(1) : '—'}</div></div>
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('BirthDate')}</div>
                  <input type="date" value={birthDate || ''} onChange={e=>{ setBirthDate(e.target.value); setBirthDateErr(''); }} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                  {birthDateErr && <div style={{ marginTop:4, fontSize:12, color:'#b91c1c' }}>{birthDateErr}</div>}
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('Gender')}</div>
                  <select value={gender} onChange={e=>setGender(e.target.value)} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }}>
                    <option value="">—</option>
                    <option value="male">{t('Male')}</option>
                    <option value="female">{t('Female')}</option>
                    <option value="other">{t('Other')}</option>
                    <option value="prefer_not">{t('PreferNotSay')}</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span>{t('HeightCm')}</span>
                    <select value={unitHeight} onChange={e=>setUnitHeight(e.target.value)} style={{ fontSize:12, border:'1px solid #e5e7eb', borderRadius:6, padding:'2px 6px' }}>
                      <option value="cm">cm</option>
                      <option value="in">in</option>
                    </select>
                  </div>
                  <input type="number" min={0} max={300} value={heightDisplay} onChange={e=>onHeightInput(e.target.value)} placeholder={unitHeight==='cm'? 'e.g., 170':'e.g., 67'} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                    <span>{t('WeightKg')}</span>
                    <select value={unitWeight} onChange={e=>setUnitWeight(e.target.value)} style={{ fontSize:12, border:'1px solid #e5e7eb', borderRadius:6, padding:'2px 6px' }}>
                      <option value="kg">kg</option>
                      <option value="lb">lb</option>
                    </select>
                  </div>
                  <input type="number" min={0} max={unitWeight==='kg'?500:1100} step="0.1" value={weightDisplay} onChange={e=>onWeightInput(e.target.value)} placeholder={unitWeight==='kg'?'e.g., 65':'e.g., 143'} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('BMI')}</div>
                  <input value={bmi} readOnly style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background:'#f8fafc' }} />
                </div>
              </div>
            )}
            {(okHint || err) && <div style={{ marginTop:8, fontSize:13 }}>{okHint && <span style={{ color:'#16a34a', marginRight:8 }}>{okHint}</span>}{err && <span style={{ color:'#b91c1c' }}>{err}</span>}</div>}
          </div>

          {/* Vitals */}
          <div style={{ background:'transparent', border:'none', borderRadius:0, padding:'16px 0', position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:16, display:'flex', gap:12 }}>
              {!editingVitals ? (
                <button onClick={()=>{ setEditingVitals(true); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <>
                  <button onClick={onSaveVitals} disabled={saving} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Save')}</button>
                  <button onClick={()=>{ resetFromUser(); setEditingVitals(false); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Cancel')}</button>
                </>
              )}
            </div>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'生命体征':'Vitals'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(180px, 1fr))', gap:12 }}>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'静息心率':'Resting HR'} (bpm)</div>
                <input type="number" min={20} max={220} value={vitals.hr} onChange={e=>setVitals(v=>({ ...v, hr: e.target.value }))} disabled={!editingVitals} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingVitals? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'收缩压':'Systolic'} (mmHg)</div>
                <input type="number" min={60} max={250} value={vitals.sys} onChange={e=>setVitals(v=>({ ...v, sys: e.target.value }))} disabled={!editingVitals} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingVitals? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'舒张压':'Diastolic'} (mmHg)</div>
                <input type="number" min={30} max={150} value={vitals.dia} onChange={e=>setVitals(v=>({ ...v, dia: e.target.value }))} disabled={!editingVitals} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingVitals? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>SpO₂ (%)</div>
                <input type="number" min={50} max={100} value={vitals.spo2} onChange={e=>setVitals(v=>({ ...v, spo2: e.target.value }))} disabled={!editingVitals} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingVitals? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'体脂率':'Body Fat'} (%)</div>
                <input type="number" min={0} max={100} value={vitals.bodyFat} onChange={e=>setVitals(v=>({ ...v, bodyFat: e.target.value }))} disabled={!editingVitals} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingVitals? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'腰围':'Waist'} (cm)</div>
                <input type="number" min={0} max={300} value={vitals.waist} onChange={e=>setVitals(v=>({ ...v, waist: e.target.value }))} disabled={!editingVitals} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingVitals? '#fff':'#f8fafc' }} />
              </div>
            </div>
          </div>

          {/* Medical history & allergies */}
          <div style={{ background:'transparent', border:'none', borderRadius:0, padding:'16px 0', position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:16, display:'flex', gap:12 }}>
              {!editingHistory ? (
                <button onClick={()=>{ setEditingHistory(true); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <>
                  <button onClick={onSaveHistory} disabled={saving} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Save')}</button>
                  <button onClick={()=>{ resetFromUser(); setEditingHistory(false); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Cancel')}</button>
                </>
              )}
            </div>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'病史与过敏':'History & Allergies'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:8 }}>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'既往病史':'Past history'}</div>
                <textarea value={history.past} onChange={e=>setHistory(h=>({ ...h, past: e.target.value }))} rows={2} disabled={!editingHistory} style={{ width:'100%', padding:8, border:'1px solid #e5e7eb', borderRadius:8, background: editingHistory? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'手术史':'Surgeries'}</div>
                <textarea value={history.surgeries} onChange={e=>setHistory(h=>({ ...h, surgeries: e.target.value }))} rows={2} disabled={!editingHistory} style={{ width:'100%', padding:8, border:'1px solid #e5e7eb', borderRadius:8, background: editingHistory? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'家族史':'Family history'}</div>
                <textarea value={history.family} onChange={e=>setHistory(h=>({ ...h, family: e.target.value }))} rows={2} disabled={!editingHistory} style={{ width:'100%', padding:8, border:'1px solid #e5e7eb', borderRadius:8, background: editingHistory? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'药物清单':'Medications'}</div>
                <textarea value={history.meds} onChange={e=>setHistory(h=>({ ...h, meds: e.target.value }))} rows={2} disabled={!editingHistory} style={{ width:'100%', padding:8, border:'1px solid #e5e7eb', borderRadius:8, background: editingHistory? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'过敏史':'Allergies'}</div>
                <textarea value={history.allergies} onChange={e=>setHistory(h=>({ ...h, allergies: e.target.value }))} rows={2} disabled={!editingHistory} style={{ width:'100%', padding:8, border:'1px solid #e5e7eb', borderRadius:8, background: editingHistory? '#fff':'#f8fafc' }} />
              </div>
            </div>
          </div>

          {/* Lifestyle */}
          <div style={{ background:'transparent', border:'none', borderRadius:0, padding:'16px 0', position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:16, display:'flex', gap:12 }}>
              {!editingLifestyle ? (
                <button onClick={()=>{ setEditingLifestyle(true); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <>
                  <button onClick={onSaveLifestyle} disabled={saving} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Save')}</button>
                  <button onClick={()=>{ resetFromUser(); setEditingLifestyle(false); }} style={{ background:'transparent', border:'none', color:'#2563eb', cursor:'pointer' }}>{t('Cancel')}</button>
                </>
              )}
            </div>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'生活方式':'Lifestyle'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'吸烟':'Smoking'}</div>
                <select value={lifestyle.smoking} onChange={e=>setLifestyle(s=>({ ...s, smoking: e.target.value }))} disabled={!editingLifestyle} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingLifestyle? '#fff':'#f8fafc' }}>
                  <option value="">—</option>
                  <option value="none">{lang==='zh'?'不吸烟':'None'}</option>
                  <option value="occasional">{lang==='zh'?'偶尔':'Occasional'}</option>
                  <option value="daily">{lang==='zh'?'每天':'Daily'}</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'饮酒':'Alcohol'}</div>
                <select value={lifestyle.alcohol} onChange={e=>setLifestyle(s=>({ ...s, alcohol: e.target.value }))} disabled={!editingLifestyle} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingLifestyle? '#fff':'#f8fafc' }}>
                  <option value="">—</option>
                  <option value="none">{lang==='zh'?'不饮酒':'None'}</option>
                  <option value="occasional">{lang==='zh'?'偶尔':'Occasional'}</option>
                  <option value="daily">{lang==='zh'?'每天':'Daily'}</option>
                </select>
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'运动频率(次/周)':'Exercise (/wk)'}</div>
                <input type="number" min={0} max={21} value={lifestyle.exercise} onChange={e=>setLifestyle(s=>({ ...s, exercise: e.target.value }))} disabled={!editingLifestyle} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingLifestyle? '#fff':'#f8fafc' }} />
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'睡眠(小时/天)':'Sleep (h/day)'}</div>
                <input type="number" min={0} max={24} step="0.1" value={lifestyle.sleepHours} onChange={e=>setLifestyle(s=>({ ...s, sleepHours: e.target.value }))} disabled={!editingLifestyle} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background: editingLifestyle? '#fff':'#f8fafc' }} />
              </div>
            </div>
          </div>

          {/* Account & Security (basic) */}
          <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16 }}>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'账号与安全':'Account & Security'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:12 }}>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{t('Email')}</div>
                <div>{user.email} · {user.email_verified_at? (lang==='zh'?'已验证':'Verified') : (lang==='zh'?'未验证':'Unverified')}</div>
              </div>
              <div>
                <div style={{ fontSize:12, color:'#64748b' }}>{t('Phone')}</div>
                <div>{user.phone || '—'} {user.phone ? ('· ' + (user.phone_verified_at? (lang==='zh'?'已验证':'Verified') : (lang==='zh'?'未验证':'Unverified'))) : ''}</div>
              </div>
              <div style={{ gridColumn:'1 / -1', display:'grid', gap:8 }}>
                <div style={{ fontWeight:600 }}>{lang==='zh'?'修改密码':'Change Password'}</div>
                <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:8 }}>
                  <input type="password" value={pwdCur} onChange={e=>setPwdCur(e.target.value)} placeholder={lang==='zh'?'当前密码':'Current password'} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                  <input type="password" value={pwdNew} onChange={e=>setPwdNew(e.target.value)} placeholder={lang==='zh'?'新密码':'New password'} style={{ padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                  <button onClick={async()=>{ try{ const r=await fetch(AUTH_BASE+'/me/password',{ method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }, body: JSON.stringify({ currentPassword: pwdCur, newPassword: pwdNew })}); const j=await r.json(); if(r.ok){ setOkHint(lang==='zh'?'已更新密码':'Password updated'); setPwdCur(''); setPwdNew(''); setTimeout(()=>setOkHint(''),1200);} else { setErr(j?.error||'password failed'); } } catch(e){ setErr('password failed'); } }} className="vh-btn vh-btn-primary">{lang==='zh'?'更新':'Update'}</button>
                </div>
              </div>
              <div style={{ gridColumn:'1 / -1', marginTop:8, paddingTop:8, borderTop:'1px solid #f1f5f9' }}>
                <div style={{ fontWeight:600, marginBottom:6 }}>{lang==='zh'?'双重验证':'Two-factor auth'}</div>
                <div style={{ display:'flex', gap:12, flexWrap:'wrap', color:'#64748b' }}>
                  <button disabled className="vh-btn vh-btn-outline" title={lang==='zh'?'即将推出':'Coming soon'}>TOTP</button>
                  <button disabled className="vh-btn vh-btn-outline" title={lang==='zh'?'即将推出':'Coming soon'}>{lang==='zh'?'短信验证码':'SMS Code'}</button>
                </div>
              </div>
              <div style={{ gridColumn:'1 / -1', paddingTop:8, borderTop:'1px solid #f1f5f9' }}>
                <div style={{ fontWeight:600, marginBottom:6 }}>{lang==='zh'?'登录设备与会话':'Devices & sessions'}</div>
                <div style={{ color:'#64748b', fontSize:13 }}>{lang==='zh'?'当前浏览器会话':'Current browser session'}</div>
              </div>
              <div style={{ gridColumn:'1 / -1', paddingTop:8, borderTop:'1px solid #f1f5f9' }}>
                <div style={{ fontWeight:600, marginBottom:6 }}>{lang==='zh'?'第三方登录绑定':'Third-party logins'}</div>
                <div style={{ display:'flex', gap:12, flexWrap:'wrap', color:'#64748b' }}>
                  <button disabled className="vh-btn vh-btn-outline" title={lang==='zh'?'即将推出':'Coming soon'}>Google</button>
                  <button disabled className="vh-btn vh-btn-outline" title={lang==='zh'?'即将推出':'Coming soon'}>Apple</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Avatar view modal */}
      {avatarViewOpen && avatarId && (
        <div onClick={()=>setAvatarViewOpen(false)} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'grid', placeItems:'center', zIndex:1000 }}>
          <div onClick={e=>e.stopPropagation()} style={{ position:'relative', maxWidth:'90vw', maxHeight:'90vh' }}>
            <img src={`${MEDIA_BASE}/file/${avatarId}`} alt="avatar" style={{ maxWidth:'90vw', maxHeight:'90vh', display:'block', borderRadius:12 }} />
            <button onClick={()=>setAvatarViewOpen(false)} className="vh-btn vh-btn-outline" style={{ position:'absolute', right:8, top:8, padding:'4px 8px' }}>✕</button>
          </div>
        </div>
      )}
      {/* Avatar edit/crop modal */}
      {avatarEditOpen && (
        <div onMouseMove={onCropMouseMove} onMouseUp={onCropMouseUp} onMouseLeave={onCropMouseUp} style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.8)', display:'grid', placeItems:'center', zIndex:1000 }}>
          <div style={{ background:'#fff', borderRadius:12, padding:16, width:'min(92vw, 560px)' }} onMouseDown={e=>e.stopPropagation()}>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'调整头像':'Adjust Avatar'}</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr', gap:12 }}>
              <div style={{ width:'100%', display:'grid', placeItems:'center' }}>
                <div onMouseDown={onCropMouseDown} style={{ width:280, height:280, borderRadius:'9999px', overflow:'hidden', position:'relative', background:'#f1f5f9', border:'1px solid #e5e7eb', cursor:'grab' }}>
                  {cropSrc && (
                    <img ref={cropImgRef} src={cropSrc} alt="crop" style={{ position:'absolute', left:`calc(50% + ${cropDx}px)`, top:`calc(50% + ${cropDy}px)`, transform:`translate(-50%, -50%) scale(${cropZoom})`, width:'auto', height:'auto', minWidth:'100%', minHeight:'100%', objectFit:'cover', transformOrigin:'center center' }} />
                  )}
                </div>
              </div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <div style={{ fontSize:12, color:'#64748b' }}>{lang==='zh'?'缩放':'Zoom'}</div>
                <input type="range" min={0.8} max={3} step={0.01} value={cropZoom} onChange={e=>setCropZoom(parseFloat(e.target.value)||1)} style={{ flex:1 }} />
              </div>
              <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
                <button onClick={()=>setAvatarEditOpen(false)} className="vh-btn vh-btn-outline">{t('Cancel')}</button>
                <button onClick={saveCroppedAvatar} className="vh-btn vh-btn-primary">{t('Save')}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Modal portals (simple inline)
export function AvatarModals(){ return null; }

// Inline modal styles for avatar view/edit
// This component relies on local state above; kept in same file to reduce complexity
