import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import multer from 'multer';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pkg from 'pg';
import { fileTypeFromBuffer } from 'file-type';
import mime from 'mime-types';

const { Pool } = pkg;
const PORT = process.env.PORT || 4003;
const MASTER_KEY = Buffer.from(process.env.MEDIA_MASTER_KEY_BASE64 || '', 'base64');
const LEGACY_KEY = crypto.createHash('sha256').update('dev_media_master_key').digest();
if (MASTER_KEY.length !== 32) {
  console.warn('[media] MEDIA_MASTER_KEY_BASE64 not 32 bytes; falling back to legacy dev key.');
}
const KEY = MASTER_KEY.length === 32 ? MASTER_KEY : LEGACY_KEY;

const pool = globalThis.__MEDIA_TEST_POOL__ || new Pool({ connectionString: process.env.DATABASE_URL });
const URL_SIGN_SECRET = process.env.MEDIA_URL_SIGN_SECRET || 'dev_url_sign_secret_change_me';

function signUrlPayload(id, userId, expMs) {
  const h = crypto.createHmac('sha256', URL_SIGN_SECRET);
  h.update(`${id}.${userId}.${expMs}`);
  return h.digest('hex');
}

function buildContentDispositionInline(filename) {
  // Sanitize ASCII fallback: remove CR/LF and non-ASCII, escape quotes
  const fallbackBase = (filename || 'file').replace(/[\r\n]+/g, ' ').replace(/["\\]/g, '_');
  const ascii = fallbackBase.replace(/[^\x20-\x7E]+/g, '_').trim() || 'file';
  // RFC 5987 encoding for UTF-8 filename*
  const enc = encodeURIComponent(filename || 'file')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  return `inline; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

async function init() {
  const statements = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto',
    `CREATE TABLE IF NOT EXISTS media_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    filename TEXT NOT NULL,
    mimetype TEXT NOT NULL,
    size BIGINT NOT NULL,
    iv BYTEA NOT NULL,
    tag BYTEA NOT NULL,
    ciphertext BYTEA NOT NULL,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
    'CREATE INDEX IF NOT EXISTS idx_media_user ON media_files(user_id)',
    'ALTER TABLE media_files ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false'
  ];
  for (const stmt of statements) {
    if (process.env.NODE_ENV === 'test' && stmt.toUpperCase().startsWith('CREATE EXTENSION')) continue;
    await pool.query(stmt);
  }
}

function verify(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('missing token');
  const token = auth.slice(7);
  return jwt.decode(token); // trust boundary: validate at gateway in prod; simplified here
}

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const app = express();
app.use(compression());
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    let userId = null;
    try {
      const payload = verify(req);
      userId = payload?.sub;
    } catch (_) {}
    if (!userId) return res.status(401).json({ error: 'unauthorized' });
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const isPublic = (req.body?.public === 'true' || req.body?.public === true);
    // Normalize original filename to UTF-8 to avoid garbled non-ASCII names
    let original = req.file.originalname || 'file';
    try { original = Buffer.from(original, 'latin1').toString('utf8'); } catch {}
    // Detect real mime when client reports octet-stream or unknown
    let detectedMime = req.file.mimetype || '';
    if (!detectedMime || detectedMime === 'application/octet-stream') {
      try {
        const ft = await fileTypeFromBuffer(req.file.buffer);
        if (ft?.mime) detectedMime = ft.mime;
      } catch {}
      if (!detectedMime) {
        const byExt = mime.lookup(original) || '';
        if (byExt) detectedMime = byExt;
      }
      if (!detectedMime) detectedMime = 'application/octet-stream';
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(req.file.buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    const { rows } = await pool.query(
      'INSERT INTO media_files (user_id, filename, mimetype, size, iv, tag, ciphertext, is_public) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, mimetype, size, is_public, created_at',
      [userId, original, detectedMime, req.file.size, iv, tag, ciphertext, isPublic]
    );
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'upload failed' });
  }
});

app.get('/list', async (req, res) => {
  try {
    const payload = verify(req);
    const userId = payload?.sub;
    const { rows } = await pool.query('SELECT id, filename, mimetype, size, created_at FROM media_files WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
    res.json(rows);
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.get('/file/:id', async (req, res) => {
  try {
    let userId = null;
    try {
      const payload = verify(req);
      userId = payload?.sub;
    } catch (_) {}
    const { rows } = await pool.query('SELECT filename, mimetype, iv, tag, ciphertext, user_id, is_public FROM media_files WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const rec = rows[0];
    // Allow access either by ownership (Authorization) or by a short-lived signed URL
    let allow = false;
    if (rec.is_public) allow = true;
    if (rec.user_id === userId) allow = true;
    if (!allow) {
      const { exp, sig, uid } = req.query;
      const expNum = exp ? parseInt(String(exp), 10) : 0;
      const now = Date.now();
      const expected = signUrlPayload(req.params.id, rec.user_id, expNum || 0);
      if (sig && uid && String(uid) === String(rec.user_id) && expNum > now && sig === expected) {
        allow = true;
      }
    }
    if (!allow) return res.status(403).json({ error: 'forbidden' });
    // Try primary key first, then legacy key (self-heal by re-encrypting if legacy works)
    const tryDecrypt = (key) => {
      const dc = crypto.createDecipheriv('aes-256-gcm', key, rec.iv);
      dc.setAuthTag(rec.tag);
      return Buffer.concat([dc.update(rec.ciphertext), dc.final()]);
    };
    let plaintext = null;
    let usedLegacy = false;
    try {
      plaintext = tryDecrypt(KEY);
    } catch (e1) {
      // Try legacy
      try {
        plaintext = tryDecrypt(LEGACY_KEY);
        usedLegacy = (MASTER_KEY.length === 32) && (Buffer.compare(KEY, LEGACY_KEY) !== 0);
      } catch (e2) {
        throw e1; // prefer primary error
      }
    }
    // If decrypted with legacy and a valid primary key is configured, re-encrypt and update row
    if (usedLegacy) {
      try {
        const iv2 = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', KEY, iv2);
        const ciphertext2 = Buffer.concat([c.update(plaintext), c.final()]);
        const tag2 = c.getAuthTag();
        await pool.query('UPDATE media_files SET iv=$1, tag=$2, ciphertext=$3 WHERE id=$4', [iv2, tag2, ciphertext2, req.params.id]);
        console.log(`[media] Self-healed and re-encrypted media ${req.params.id} with primary key.`);
      } catch (e) {
        console.warn('[media] Self-heal re-encrypt failed:', e?.message || e);
      }
    }
    res.setHeader('Content-Type', rec.mimetype);
    res.setHeader('Content-Disposition', buildContentDispositionInline(rec.filename));
    res.send(plaintext);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'download failed' });
  }
});

// Short-lived signed URL for downloading without Authorization header (to avoid CORS preflight)
app.get('/file_url/:id', async (req, res) => {
  try {
    let userId = null;
    try {
      const payload = verify(req);
      userId = payload?.sub;
    } catch (_) {}
    const { rows } = await pool.query('SELECT user_id, is_public FROM media_files WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const rec = rows[0];
    if (!rec.is_public && rec.user_id !== userId) return res.status(403).json({ error: 'forbidden' });
    const exp = Date.now() + 5 * 60 * 1000; // 5 minutes
    const sig = signUrlPayload(req.params.id, rec.user_id, exp);
    const base = `${req.protocol}://${req.get('host')}`;
    const url = `${base}/file/${req.params.id}?uid=${encodeURIComponent(rec.user_id)}&exp=${exp}&sig=${sig}`;
    res.json({ url, exp });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'sign failed' });
  }
});

async function start() {
  await init();
  return app.listen(PORT, () => console.log(`media-service on :${PORT}`));
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { app, init, pool, KEY, LEGACY_KEY, start };
