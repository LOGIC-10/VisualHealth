"use client";
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../components/i18n';

const ANALYSIS_BASE = process.env.NEXT_PUBLIC_API_ANALYSIS || 'http://localhost:4004';

export default function AnalysisListPage() {
  const { t } = useI18n();
  const [token, setToken] = useState(null);
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem('vh_token');
    setToken(t);
    if (!t) { setLoading(false); return; }
    (async () => {
      try {
        const r = await fetch(ANALYSIS_BASE + '/records', { headers: { Authorization: `Bearer ${t}` } });
        const list = await r.json();
        setFiles(Array.isArray(list) ? list : []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const gridCols = useMemo(() => ({ columns: 'repeat(auto-fill, minmax(260px, 1fr))' }), []);

  if (!token) {
    return (
      <div style={{ maxWidth: 960, margin: '24px auto', padding: '0 24px' }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('AnalysisTitle')}</h1>
        <p>{t('LoginToView')}</p>
        <a href="/auth" style={{ textDecoration:'none', padding:'10px 14px', borderRadius:8, background:'#111', color:'#fff' }}>{t('Login')}</a>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '24px auto', padding: '0 24px' }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
        <h1 style={{ fontSize: 28, marginBottom: 12 }}>{t('AnalysisTitle')}</h1>
        <a href="/analysis/new" style={{ textDecoration:'none', padding:'10px 14px', borderRadius:8, border:'1px solid #e5e7eb', background:'#fff' }}>{t('NewAnalysis')}</a>
      </div>
      {loading && <div>{t('Loading')}</div>}
      {!loading && files.length === 0 && (
        <div style={{ color:'#64748b' }}>{t('NoRecords')}</div>
      )}
      <div style={{ display:'grid', gridTemplateColumns: gridCols.columns, gap: 12 }}>
        {files.map(f => (
          <a key={f.id} href={`/analysis/${f.id}`} style={{ textDecoration:'none', color:'inherit' }}>
            <div style={{ border:'1px solid #e5e7eb', borderRadius: 12, padding: 12, background:'#fff' }}>
              <div style={{ fontWeight:600, marginBottom:6, color:'#0f172a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{f.title || f.filename}</div>
              <div style={{ color:'#64748b', fontSize:13 }}>{new Date(f.created_at).toLocaleString()}</div>
              <div style={{ color:'#64748b', fontSize:13, marginTop:6 }}>{f.mimetype} · {(f.size/1024).toFixed(1)} KB</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
