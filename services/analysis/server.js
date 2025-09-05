import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

const PORT = process.env.PORT || 4004;
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const VIZ_BASE = process.env.VIZ_BASE || 'http://viz-service:4006';
const LLM_SVC = process.env.LLM_SVC || 'http://llm-service:4007';

async function init() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS analysis_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      media_id UUID NOT NULL,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size BIGINT NOT NULL,
      title TEXT,
      adv JSONB,
      spec_media_id UUID,
      ai JSONB,
      ai_generated_at TIMESTAMPTZ,
      features JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_user ON analysis_records(user_id);
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS adv JSONB;
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS spec_media_id UUID;
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS ai JSONB;
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMPTZ;
    -- Chat messages per analysis record
    CREATE TABLE IF NOT EXISTS analysis_chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      record_id UUID NOT NULL,
      user_id UUID NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_record ON analysis_chat_messages(record_id);
    CREATE INDEX IF NOT EXISTS idx_chat_user ON analysis_chat_messages(user_id);
  `);
}

function verify(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('missing token');
  const token = auth.slice(7);
  // Dev: trust decode only; in prod verify signature with shared secret
  return jwt.decode(token);
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Accept JSON: { sampleRate: number, channel: number, pcm: number[] }
app.post('/analyze', (req, res) => {
  try {
    const { sampleRate, pcm } = req.body || {};
    if (!sampleRate || !Array.isArray(pcm) || pcm.length === 0) {
      return res.status(400).json({ error: 'sampleRate and pcm required' });
    }
    // Normalize to Float32 array
    const x = Float32Array.from(pcm);

    // Basic features
    const n = x.length;
    const mean = x.reduce((a, b) => a + b, 0) / n;
    const variance = x.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const rms = Math.sqrt(variance);
    // Zero-crossing rate
    let zc = 0;
    for (let i = 1; i < n; i++) {
      if ((x[i - 1] >= 0 && x[i] < 0) || (x[i - 1] < 0 && x[i] >= 0)) zc++;
    }
    const zcr = zc / n * sampleRate; // crossings per second

    // Simple envelope and peak rate (very rough proxy)
    const window = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms
    const env = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(x[i]);
      acc += v - (i >= window ? Math.abs(x[i - window]) : 0);
      env[i] = acc / Math.min(i + 1, window);
    }
    // Peak detection
    const peaks = [];
    for (let i = 1; i < n - 1; i++) {
      if (env[i] > env[i - 1] && env[i] > env[i + 1] && env[i] > 0.02) {
        peaks.push(i);
      }
    }
    const seconds = n / sampleRate;
    const peakRate = peaks.length / seconds; // events per second

    res.json({
      sampleRate,
      durationSec: seconds,
      rms,
      zcrPerSec: zcr,
      envelopePeaks: peaks.slice(0, 1000),
      peakRatePerSec: peakRate
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'analysis failed' });
  }
});

// Persist and list analysis records
app.post('/records', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    const { mediaId, filename, mimetype, size, features } = req.body || {};
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (!mediaId || !filename || !mimetype || !size || !features) {
      return res.status(400).json({ error: 'mediaId, filename, mimetype, size, features required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO analysis_records (user_id, media_id, filename, mimetype, size, features)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, media_id, filename, mimetype, size, created_at`,
      [userId, mediaId, filename, mimetype, size, features]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'create failed' });
  }
});

app.get('/records', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    const { rows } = await pool.query(
      'SELECT id, media_id, filename, title, mimetype, size, created_at, (adv IS NOT NULL) AS has_adv, (spec_media_id IS NOT NULL) AS has_spec, (ai IS NOT NULL) AS has_ai, ai_generated_at FROM analysis_records WHERE user_id=$1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.get('/records/:id', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
  const { rows } = await pool.query(
      'SELECT id, media_id, filename, title, mimetype, size, created_at, features, adv, spec_media_id, ai, ai_generated_at FROM analysis_records WHERE id=$1 AND user_id=$2',
      [req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.patch('/records/:id', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    const { title, adv, specMediaId, ai, aiGeneratedAt } = req.body || {};
    if (title==null && adv==null && specMediaId==null && ai==null && aiGeneratedAt==null) return res.status(400).json({ error: 'no fields' });
    const { rows } = await pool.query(
      'UPDATE analysis_records SET title=COALESCE($1,title), adv=COALESCE($2,adv), spec_media_id=COALESCE($3,spec_media_id), ai=COALESCE($4,ai), ai_generated_at=COALESCE($5,ai_generated_at) WHERE id=$6 AND user_id=$7 RETURNING id, media_id, filename, title, mimetype, size, created_at, adv, spec_media_id, ai, ai_generated_at',
      [title ?? null, adv ?? null, specMediaId ?? null, ai ?? null, aiGeneratedAt ?? null, req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'update failed' });
  }
});

// Delete an analysis record
app.delete('/records/:id', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    const { rowCount } = await pool.query(
      'DELETE FROM analysis_records WHERE id=$1 AND user_id=$2',
      [req.params.id, userId]
    );
    if (!rowCount) return res.status(404).json({ error: 'not found' });
    res.status(204).end();
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'delete failed' });
  }
});

init().then(() => app.listen(PORT, () => console.log(`analysis-service on :${PORT}`)));

// Start AI analysis in background and persist result
app.post('/records/:id/ai_start', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    const { sampleRate, pcm, lang } = req.body || {};
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (!sampleRate || !Array.isArray(pcm) || pcm.length === 0) {
      return res.status(400).json({ error: 'sampleRate and pcm required' });
    }
    // ensure record belongs to user
    const rec = await pool.query('SELECT id FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rec.rowCount) return res.status(404).json({ error: 'not found' });

    // Idempotency: prevent duplicate background runs for same lang
    const L = lang || 'zh';
    try {
      const ex = await pool.query('SELECT ai FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
      let aiObj = {};
      try { aiObj = ex.rows[0]?.ai || {}; } catch {}
      aiObj.texts = aiObj.texts || {};
      aiObj.pending = aiObj.pending || {};
      if (aiObj.texts[L] && aiObj.texts[L].length > 0) {
        return res.status(202).json({ started: false, already: true });
      }
      if (aiObj.pending[L]) {
        return res.status(202).json({ started: false, pending: true });
      }
      // mark pending and persist immediately to block duplicates
      aiObj.pending[L] = true;
      await pool.query('UPDATE analysis_records SET ai=$1 WHERE id=$2 AND user_id=$3', [ aiObj, req.params.id, userId ]);
    } catch(e) {
      // non-fatal; continue
    }

    res.status(202).json({ started: true });

    // background task
    (async () => {
      try {
        const m = await fetch(VIZ_BASE + '/hard_algo_metrics', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sampleRate, pcm })
        });
        const metrics = await m.json();
        if (metrics?.error) throw new Error(metrics.error);
        // Build LLM prompt outside of algorithm service (decoupled)
        const L = lang || 'zh';
        let sys, user;
        if (L === 'zh') {
          sys = (
            '你是一名心血管科医生助手。' +
            '根据给定的心音算法指标，生成非诊断性意见。' +
            '要求：使用中文，严格按 Markdown 输出，包含清晰的小标题、列表、重点加粗。' +
            '语气客观谨慎；若证据不足，请明确说明不确定。'
          );
          user = (
            '请基于以下 JSON 指标，按 Markdown 输出三个部分:\n' +
            '## 总结\n简要 2-3 句。\n\n' +
            '## 可能的风险\n若无明显异常，写：未见明显异常。\n\n' +
            '## 建议\n包含生活方式、是否建议复测、何时就医等。\n\n' +
            '### 指标\n```json\n' + JSON.stringify(metrics) + '\n```'
          );
        } else {
          sys = (
            'You are a cardiology assistant.' +
            ' Based on PCG metrics, produce a non-diagnostic report in English.' +
            ' Requirements: strictly output Markdown with headings, bullet lists, and bold highlights.' +
            ' Be clear and cautious; state uncertainty when evidence is insufficient.'
          );
          user = (
            'Using the JSON metrics below, return three Markdown sections:\n' +
            '## Summary\n2–3 sentences.\n\n' +
            '## Potential Risks\nIf none, say: No obvious abnormality.\n\n' +
            '## Advice\nLifestyle, whether to retest, and when to see a doctor.\n\n' +
            '### Metrics\n```json\n' + JSON.stringify(metrics) + '\n```'
          );
        }
        const a = await fetch(LLM_SVC + '/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [ { role: 'system', content: sys }, { role: 'user', content: user } ], temperature: 0.2 })
        });
        const aj = await a.json();
        if (aj?.error) throw new Error(aj.error);
        const ts = new Date().toISOString();
        // merge with existing AI JSON to support multiple languages
        const ex = await pool.query('SELECT ai FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
        let aiObj = {};
        try { aiObj = ex.rows[0]?.ai || {}; } catch {}
        aiObj.model = aj.model || aiObj.model;
        aiObj.metrics = aiObj.metrics || metrics; // keep first metrics
        aiObj.texts = aiObj.texts || {};
        aiObj.texts[L] = aj.text || '';
        aiObj.generated_at = aiObj.generated_at || {};
        aiObj.generated_at[L] = ts;
        aiObj.pending = aiObj.pending || {};
        aiObj.pending[L] = false;
        await pool.query('UPDATE analysis_records SET ai=$1, ai_generated_at=$2 WHERE id=$3 AND user_id=$4', [ aiObj, ts, req.params.id, userId ]);
        console.log(`[analysis] AI generated for record ${req.params.id}`);
      } catch (e) {
        console.warn('[analysis] AI background task failed:', e?.message || e);
        // Clear pending flag on failure to allow retry
        try {
          const ex2 = await pool.query('SELECT ai FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
          let aiObj2 = {};
          try { aiObj2 = ex2.rows[0]?.ai || {}; } catch {}
          aiObj2.pending = aiObj2.pending || {};
          aiObj2.pending[L] = false;
          aiObj2.last_error = aiObj2.last_error || {};
          aiObj2.last_error[L] = (e?.message) || String(e);
          await pool.query('UPDATE analysis_records SET ai=$1 WHERE id=$2 AND user_id=$3', [ aiObj2, req.params.id, userId ]);
        } catch {}
      }
    })();

  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'ai start failed' });
  }
});

// List chat messages for a record (owned by user)
app.get('/records/:id/chat', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    // Ensure ownership
    const rec = await pool.query('SELECT id FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rec.rowCount) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      'SELECT id, role, content, created_at FROM analysis_chat_messages WHERE record_id=$1 AND user_id=$2 ORDER BY created_at ASC',
      [req.params.id, userId]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'chat list failed' });
  }
});

// Append a chat message for a record
app.post('/records/:id/chat', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const { role, content } = req.body || {};
    if (!role || !content || (role !== 'user' && role !== 'assistant')) {
      return res.status(400).json({ error: 'role and content required' });
    }
    // Ensure ownership
    const rec = await pool.query('SELECT id FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rec.rowCount) return res.status(404).json({ error: 'not found' });
    const { rows } = await pool.query(
      'INSERT INTO analysis_chat_messages (record_id, user_id, role, content) VALUES ($1,$2,$3,$4) RETURNING id, role, content, created_at',
      [req.params.id, userId, role, content]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'chat append failed' });
  }
});
