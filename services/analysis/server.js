import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

const PORT = process.env.PORT || 4004;
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

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
      features JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_analysis_user ON analysis_records(user_id);
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS adv JSONB;
    ALTER TABLE analysis_records ADD COLUMN IF NOT EXISTS spec_media_id UUID;
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
      'SELECT id, media_id, filename, title, mimetype, size, created_at, (adv IS NOT NULL) AS has_adv, (spec_media_id IS NOT NULL) AS has_spec FROM analysis_records WHERE user_id=$1 ORDER BY created_at DESC',
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
      'SELECT id, media_id, filename, title, mimetype, size, created_at, features, adv, spec_media_id FROM analysis_records WHERE id=$1 AND user_id=$2',
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
    const { title, adv, specMediaId } = req.body || {};
    if (title==null && adv==null && specMediaId==null) return res.status(400).json({ error: 'no fields' });
    const { rows } = await pool.query(
      'UPDATE analysis_records SET title=COALESCE($1,title), adv=COALESCE($2,adv), spec_media_id=COALESCE($3,spec_media_id) WHERE id=$4 AND user_id=$5 RETURNING id, media_id, filename, title, mimetype, size, created_at, adv, spec_media_id',
      [title ?? null, adv ?? null, specMediaId ?? null, req.params.id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'update failed' });
  }
});

init().then(() => app.listen(PORT, () => console.log(`analysis-service on :${PORT}`)));
