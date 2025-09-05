import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import pkg from 'pg';

const { Pool } = pkg;

const PORT = process.env.PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Progressive schema upgrades
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm SMALLINT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_kg REAL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_media_id UUID;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_display_name_change_at TIMESTAMPTZ;
    -- Extensions for privacy and security
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_visibility JSONB;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_extras JSONB;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
  `);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/signup', async (req, res) => {
  try {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name',
      [email.toLowerCase(), hash, displayName || null]
    );
    const user = rows[0];
    const token = signToken(user);
    res.json({ token, user });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email already exists' });
    console.error(e);
    res.status(500).json({ error: 'signup failed' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const { rows } = await pool.query('SELECT id, email, password_hash, display_name FROM users WHERE email=$1', [email.toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = signToken(user);
    res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'login failed' });
  }
});

app.get('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query(
      `SELECT id, email, display_name, phone, birth_date, gender, height_cm, weight_kg, avatar_media_id, last_display_name_change_at,
              profile_visibility, profile_extras, email_verified_at, phone_verified_at, totp_enabled
       FROM users WHERE id=$1`,
      [payload.sub]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const u = rows[0];
    // Provide client hint for next allowed display_name change (30 days window)
    let next_allowed_display_name_change_at = null;
    if (u.last_display_name_change_at) {
      next_allowed_display_name_change_at = new Date(new Date(u.last_display_name_change_at).getTime() + 30*24*3600*1000).toISOString();
    }
    res.json({ ...u, next_allowed_display_name_change_at });
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
});

app.patch('/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { displayName, phone, birthDate, gender, heightCm, weightKg, avatarMediaId, visibility, extras } = req.body || {};

    // Load current to compare and handle cooldown only when actual change requested
    const cur = await pool.query('SELECT display_name, last_display_name_change_at FROM users WHERE id=$1', [payload.sub]);
    const currentDisplay = cur.rows[0]?.display_name ?? null;
    const last = cur.rows[0]?.last_display_name_change_at ?? null;

    // Normalize proposed display name
    let proposedDisplay = (typeof displayName !== 'undefined' && displayName !== null)
      ? String(displayName).trim()
      : null;

    // If provided but effectively identical, ignore to avoid triggering cooldown
    if (proposedDisplay !== null && proposedDisplay === (currentDisplay ?? '')) {
      proposedDisplay = null;
    }

    // Enforce cooldown only when a real change is requested
    if (proposedDisplay !== null && last) {
      const next = new Date(new Date(last).getTime() + 30*24*3600*1000);
      if (new Date() < next) {
        return res.status(429).json({ error: 'display name recently changed', nextAllowedAt: next.toISOString() });
      }
    }

    // Validate birth date if provided
    if (typeof birthDate !== 'undefined' && birthDate) {
      const bd = new Date(birthDate);
      const now = new Date();
      if (isNaN(bd.getTime()) || bd > now) {
        return res.status(400).json({ error: 'invalid birth date' });
      }
    }

    const { rows } = await pool.query(
      `UPDATE users SET
        display_name = COALESCE($1, display_name),
        phone = COALESCE($2, phone),
        birth_date = COALESCE($3, birth_date),
        gender = COALESCE($4, gender),
        height_cm = COALESCE($5, height_cm),
        weight_kg = COALESCE($6, weight_kg),
        avatar_media_id = COALESCE($7, avatar_media_id),
        profile_visibility = COALESCE($8, profile_visibility),
        profile_extras = COALESCE(profile_extras, '{}'::jsonb) || COALESCE($9, '{}'::jsonb),
        last_display_name_change_at = CASE WHEN $1 IS NOT NULL AND $1 <> display_name THEN now() ELSE last_display_name_change_at END
       WHERE id=$10
       RETURNING id, email, display_name, phone, birth_date, gender, height_cm, weight_kg, avatar_media_id, last_display_name_change_at,
                 profile_visibility, profile_extras, email_verified_at, phone_verified_at, totp_enabled`,
      [
        proposedDisplay,
        phone ?? null,
        birthDate ?? null,
        gender ?? null,
        (typeof heightCm === 'number' ? Math.max(0, Math.min(300, Math.round(heightCm))) : null),
        (typeof weightKg === 'number' ? Math.max(0, Math.min(500, Number(weightKg))) : null),
        avatarMediaId ?? null,
        (visibility && typeof visibility === 'object') ? JSON.stringify(visibility) : null,
        (extras && typeof extras === 'object') ? JSON.stringify(extras) : null,
        payload.sub,
      ]
    );
    const u = rows[0];
    let next_allowed_display_name_change_at = null;
    if (u.last_display_name_change_at) next_allowed_display_name_change_at = new Date(new Date(u.last_display_name_change_at).getTime() + 30*24*3600*1000).toISOString();
    res.json({ ...u, next_allowed_display_name_change_at });
  } catch (e) {
    res.status(400).json({ error: 'update failed' });
  }
});

// Change password
app.post('/me/password', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'missing fields' });
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [payload.sub]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid current password' });
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, payload.sub]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'password change failed' });
  }
});

// Bulk public user info lookup: returns minimal public profile fields
// Input: { ids: [uuid, ...] }
// Output: { users: [{ id, email, display_name, avatar_media_id }] }
app.post('/users/bulk', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? Array.from(new Set(req.body.ids)).filter(Boolean) : [];
    if (!ids.length) return res.json({ users: [] });
    // Limit to reasonable size to protect service
    if (ids.length > 200) return res.status(400).json({ error: 'too many ids' });
    const { rows } = await pool.query(
      `SELECT id, email, display_name, avatar_media_id FROM users WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    res.json({ users: rows });
  } catch (e) {
    res.status(400).json({ error: 'bulk lookup failed' });
  }
});

init().then(() => app.listen(PORT, () => console.log(`auth-service on :${PORT}`)));
