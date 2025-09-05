"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../components/i18n';

const AUTH_BASE = process.env.NEXT_PUBLIC_API_AUTH || 'http://localhost:4001';
const MEDIA_BASE = process.env.NEXT_PUBLIC_API_MEDIA || 'http://localhost:4003';

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
      if ((birthDate || '') !== (user?.birth_date || '')) { body.birthDate = birthDate || null; localPatch.birth_date = birthDate || ''; }
      if ((gender || '') !== (user?.gender || '')) { body.gender = gender || null; localPatch.gender = gender || ''; }
      const hVal = heightCm ? parseInt(heightCm, 10) : null;
      const hCur = (user?.height_cm != null ? Number(user.height_cm) : null);
      if (hVal !== hCur) { body.heightCm = hVal; localPatch.height_cm = (hVal != null ? hVal : null); }
      const wVal = weightKg ? parseFloat(weightKg) : null;
      const wCur = (user?.weight_kg != null ? Number(user.weight_kg) : null);
      if (wVal !== wCur) { body.weightKg = wVal; localPatch.weight_kg = (wVal != null ? wVal : null); }
      const aCur = user?.avatar_media_id || null;
      if ((avatarId || null) !== aCur) { body.avatarMediaId = avatarId || null; localPatch.avatar_media_id = (avatarId || null); }

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
      // Merge server echo if provided; otherwise fall back to localPatch so UI reflects saved data immediately
      const merged = (function(){
        const base = { ...(u || {}) };
        return { ...base, ...localPatch, ...(j && j.id ? j : {}) };
      })();
      setUser(merged);
      try { window.dispatchEvent(new CustomEvent('vh_user_change', { detail: merged })); } catch {}
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
      <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('ProfileTitle')}</h1>
      {!user && <div>{t('Loading')}</div>}
      {user && (
        <div style={{ display:'grid', gap:16 }}>
          {/* Account card */}
          <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16 }}>
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
                  {/* Small edit button to change */}
                  <button onClick={(e)=>{ e.stopPropagation(); fileInputRef.current?.click(); }} title={t('ChangeAvatar')} style={{ position:'absolute', right:2, bottom:2, width:22, height:22, borderRadius:9999, background:'rgba(0,0,0,0.6)', color:'#fff', display:'grid', placeItems:'center', fontSize:12, border:'none', cursor:'pointer' }}>✎</button>
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
          <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16, position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:12 }}>
              {!editingBasic ? (
                <button onClick={()=>{ setEditingBasic(true); setErr(''); setOkHint(''); }} className="vh-btn vh-btn-outline" style={{ padding:'4px 8px', color:'#2563eb' }}>✎ {lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  <button onClick={onSaveBasic} disabled={saving} className="vh-btn vh-btn-primary" style={{ padding:'6px 10px' }}>{t('Save')}</button>
                  <button onClick={()=>{ setDisplayName(user.display_name||''); setPhone(user.phone||''); setEditingBasic(false); }} className="vh-btn vh-btn-outline" style={{ padding:'6px 10px' }}>{t('Cancel')}</button>
                </div>
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
            {(okHint || err) && <div style={{ marginTop:8, fontSize:13 }}>{okHint && <span style={{ color:'#16a34a', marginRight:8 }}>{okHint}</span>}{err && <span style={{ color:'#b91c1c' }}>{err}</span>}</div>}
          </div>

          {/* Medical info card (view/edit toggle) */}
          <div style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:16, position:'relative' }}>
            <div style={{ position:'absolute', right:12, top:12 }}>
              {!editingMedical ? (
                <button onClick={()=>{ setEditingMedical(true); setErr(''); setOkHint(''); }} className="vh-btn vh-btn-outline" style={{ padding:'4px 8px', color:'#2563eb' }}>✎ {lang==='zh'?'编辑':'Edit'}</button>
              ) : (
                <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                  <button onClick={onSaveMedical} disabled={saving} className="vh-btn vh-btn-primary" style={{ padding:'6px 10px' }}>{t('Save')}</button>
                  <button onClick={()=>{ setBirthDate(user.birth_date||''); setGender(user.gender||''); setHeightCm(user.height_cm!=null?String(user.height_cm):''); setWeightKg(user.weight_kg!=null?String(user.weight_kg):''); setEditingMedical(false); }} className="vh-btn vh-btn-outline" style={{ padding:'6px 10px' }}>{t('Cancel')}</button>
                </div>
              )}
            </div>
            <div style={{ fontWeight:600, marginBottom:8 }}>{lang==='zh'?'医疗相关':'Medical'}</div>
            {!editingMedical ? (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('BirthDate')}</div><div>{user.birth_date || '—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('Gender')}</div><div>{labelGender(user.gender)}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('HeightCm')}</div><div>{user.height_cm!=null? `${user.height_cm} cm`:'—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('WeightKg')}</div><div>{user.weight_kg!=null? `${user.weight_kg} kg`:'—'}</div></div>
                <div><div style={{ fontSize:12, color:'#64748b' }}>{t('BMI')}</div><div>{(user.height_cm && user.weight_kg)? (user.weight_kg/Math.pow(user.height_cm/100,2)).toFixed(1) : '—'}</div></div>
              </div>
            ) : (
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:12 }}>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('BirthDate')}</div>
                  <input type="date" value={birthDate || ''} onChange={e=>setBirthDate(e.target.value)} style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
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
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('HeightCm')}</div>
                  <input type="number" min={0} max={300} value={heightCm} onChange={e=>setHeightCm(e.target.value)} placeholder="e.g., 170" style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('WeightKg')}</div>
                  <input type="number" min={0} max={500} step="0.1" value={weightKg} onChange={e=>setWeightKg(e.target.value)} placeholder="e.g., 65" style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8 }} />
                </div>
                <div>
                  <div style={{ fontSize:12, color:'#64748b' }}>{t('BMI')}</div>
                  <input value={bmi} readOnly style={{ width:'100%', padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, background:'#f8fafc' }} />
                </div>
              </div>
            )}
            {(okHint || err) && <div style={{ marginTop:8, fontSize:13 }}>{okHint && <span style={{ color:'#16a34a', marginRight:8 }}>{okHint}</span>}{err && <span style={{ color:'#b91c1c' }}>{err}</span>}</div>}
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
