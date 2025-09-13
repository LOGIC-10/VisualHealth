import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

const PORT = process.env.PORT || 4004;
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const VIZ_BASE = process.env.VIZ_BASE || 'http://viz-service:4006';
const USE_HSMM = (process.env.VIZ_USE_HSMM === '1');
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
    -- Cross-record cache by audio content hash (sha-256 hex)
    CREATE TABLE IF NOT EXISTS pcg_cache (
      hash TEXT PRIMARY KEY,
      spec_media_id UUID,
      adv JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

function verify(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('missing token');
  const token = auth.slice(7);
  // Dev: trust decode only; in prod verify signature with shared secret
  return jwt.decode(token);
}

function verifyFromHeaderOrQuery(req) {
  try {
    return verify(req);
  } catch (e) {
    const q = req.query || {};
    const token = q.access_token;
    if (!token) throw e;
    // In dev we just decode; in prod you should verify signature
    return jwt.decode(token);
  }
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// --- SSE streams per analysis record ---
const sseClients = new Map(); // recordId -> Set(res)

app.get('/records/:id/stream', async (req, res) => {
  try {
    const payload = verifyFromHeaderOrQuery(req);
    const userId = payload?.sub;
    if (!userId) return res.status(401).end();
    // Ensure ownership before attaching stream
    const rec = await pool.query('SELECT id FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rec.rowCount) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Initial comment to establish stream
    res.write(': connected\n\n');
    // Add client
    if (!sseClients.has(req.params.id)) sseClients.set(req.params.id, new Set());
    const set = sseClients.get(req.params.id);
    set.add(res);

    req.on('close', () => {
      try { set.delete(res); } catch {}
    });
  } catch (e) {
    return res.status(401).end();
  }
});

function sseBroadcast(recordId, event, dataObj) {
  const set = sseClients.get(recordId);
  if (!set || set.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(dataObj || {})}\n\n`;
  for (const res of Array.from(set)) {
    try { res.write(payload); } catch {}
  }
}

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
    const { title, adv, specMediaId, ai, aiGeneratedAt, audioHash } = req.body || {};
    if (title==null && adv==null && specMediaId==null && ai==null && aiGeneratedAt==null) return res.status(400).json({ error: 'no fields' });
    const { rows } = await pool.query(
      'UPDATE analysis_records SET title=COALESCE($1,title), adv=COALESCE($2,adv), spec_media_id=COALESCE($3,spec_media_id), ai=COALESCE($4,ai), ai_generated_at=COALESCE($5,ai_generated_at) WHERE id=$6 AND user_id=$7 RETURNING id, media_id, filename, title, mimetype, size, created_at, adv, spec_media_id, ai, ai_generated_at',
      [title ?? null, adv ?? null, specMediaId ?? null, ai ?? null, aiGeneratedAt ?? null, req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const updated = rows[0];
    // Best-effort: update cross-record cache when audioHash present
    if (audioHash && typeof audioHash === 'string' && audioHash.length >= 32) {
      try {
        await pool.query(
          `INSERT INTO pcg_cache(hash, spec_media_id, adv, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (hash) DO UPDATE SET
             spec_media_id=COALESCE(EXCLUDED.spec_media_id, pcg_cache.spec_media_id),
             adv=COALESCE(EXCLUDED.adv, pcg_cache.adv),
             updated_at=now()`,
          [audioHash, specMediaId ?? null, adv ?? null]
        );
      } catch (e) { /* non-fatal */ }
    }
    // SSE notify
    if (specMediaId) sseBroadcast(req.params.id, 'spec_done', { specMediaId });
    if (adv) sseBroadcast(req.params.id, 'pcg_done', { adv });
    res.json(updated);
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

// --- Simple cache API for viz-service (hash -> {spec_media_id, adv}) ---
app.get('/cache/:hash', async (req, res) => {
  try {
    // Require auth (but cache itself is cross-user)
    const payload = verifyFromHeaderOrQuery(req);
    if (!payload?.sub) return res.status(401).json({ error: 'unauthorized' });
    const h = String(req.params.hash || '').trim();
    if (!h) return res.status(400).json({ error: 'missing hash' });
    const { rows } = await pool.query('SELECT hash, spec_media_id, adv FROM pcg_cache WHERE hash=$1', [h]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'cache get failed' });
  }
});

app.post('/cache', async (req, res) => {
  try {
    const payload = verifyFromHeaderOrQuery(req);
    if (!payload?.sub) return res.status(401).json({ error: 'unauthorized' });
    const { hash, specMediaId, adv } = req.body || {};
    if (!hash) return res.status(400).json({ error: 'missing hash' });
    const { rows } = await pool.query(
      `INSERT INTO pcg_cache(hash, spec_media_id, adv, created_at, updated_at)
       VALUES ($1,$2,$3, now(), now())
       ON CONFLICT (hash) DO UPDATE SET
         spec_media_id=COALESCE(EXCLUDED.spec_media_id, pcg_cache.spec_media_id),
         adv=COALESCE(EXCLUDED.adv, pcg_cache.adv),
         updated_at=now()
       RETURNING hash, spec_media_id, adv`,
      [String(hash), specMediaId ?? null, adv ?? null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'cache upsert failed' });
  }
});


// Save AI report (client-provided text) for a record and language
app.post('/records/:id/ai', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    const { lang, text, model } = req.body || {};
    const L = (lang || 'zh').trim();
    const T = (text || '').toString();
    if (!T) return res.status(400).json({ error: 'text required' });
    const rec = await pool.query('SELECT id, ai FROM analysis_records WHERE id=$1 AND user_id=$2', [req.params.id, userId]);
    if (!rec.rowCount) return res.status(404).json({ error: 'not found' });
    let aiObj = {};
    try { aiObj = rec.rows[0]?.ai || {}; } catch {}
    aiObj.model = model || aiObj.model || 'llm';
    aiObj.texts = aiObj.texts || {};
    aiObj.texts[L] = T;
    const ts = new Date().toISOString();
    const { rows } = await pool.query('UPDATE analysis_records SET ai=$1, ai_generated_at=$2 WHERE id=$3 AND user_id=$4 RETURNING ai, ai_generated_at', [ aiObj, ts, req.params.id, userId ]);
    return res.json({ ok: true, ai: rows[0].ai, ai_generated_at: rows[0].ai_generated_at });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'ai save failed' });
  }
});
