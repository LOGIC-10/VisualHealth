import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

const { Pool } = pkg;
const PORT = process.env.PORT || 4003;
const MASTER_KEY = Buffer.from(process.env.MEDIA_MASTER_KEY_BASE64 || '', 'base64');
if (MASTER_KEY.length !== 32) {
  console.warn('[media] MEDIA_MASTER_KEY_BASE64 not set to 32 bytes base64. Using INSECURE dev key.');
}
const KEY = MASTER_KEY.length === 32 ? MASTER_KEY : crypto.createHash('sha256').update('dev_media_master_key').digest();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE IF NOT EXISTS media_files (
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
  ); CREATE INDEX IF NOT EXISTS idx_media_user ON media_files(user_id);
  ALTER TABLE media_files ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT false;`);
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
app.use(helmet());
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
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(req.file.buffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    const { rows } = await pool.query(
      'INSERT INTO media_files (user_id, filename, mimetype, size, iv, tag, ciphertext, is_public) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, mimetype, size, is_public, created_at',
      [userId, req.file.originalname, req.file.mimetype, req.file.size, iv, tag, ciphertext, isPublic]
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
    if (!rec.is_public && rec.user_id !== userId) return res.status(403).json({ error: 'forbidden' });
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, rec.iv);
    decipher.setAuthTag(rec.tag);
    const plaintext = Buffer.concat([decipher.update(rec.ciphertext), decipher.final()]);
    res.setHeader('Content-Type', rec.mimetype);
    res.setHeader('Content-Disposition', `inline; filename="${rec.filename}"`);
    res.send(plaintext);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'download failed' });
  }
});

init().then(() => app.listen(PORT, () => console.log(`media-service on :${PORT}`)));
