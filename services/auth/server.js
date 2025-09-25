import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import pkg from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { Resend } from 'resend';

dotenv.config();

const { Pool } = pkg;

const PORT = process.env.PORT || 4001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_change_me';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const pool = globalThis.__AUTH_TEST_POOL__ || new Pool({ connectionString: process.env.DATABASE_URL });

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
function buildFrom(raw){
  const fallback = 'VisualHealth <onboarding@resend.dev>';
  const v = (raw||'').trim(); if (!v) return fallback;
  if (/[<].+@.+[>]/.test(v)) return v; // already Name <email>
  const m1 = v.match(/^(.*?)\s*\(([^)]+@[^)]+)\)\s*$/); // Name (email)
  if (m1) { const name=(m1[1]||'VisualHealth').trim()||'VisualHealth'; const em=m1[2].trim(); return `${name} <${em}>`; }
  const m2 = v.match(/^(.*?)\s*([^\s<>]+@[^\s<>]+)$/); // Name email
  if (m2) { const name=(m2[1]||'VisualHealth').trim()||'VisualHealth'; const em=m2[2].trim(); return `${name} <${em}>`; }
  if (/^[^\s<>]+@[^\s<>]+$/.test(v)) return `VisualHealth <${v}>`;
  return fallback;
}
const EMAIL_FROM = buildFrom(process.env.EMAIL_FROM);

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function generate6Code(){ return String(Math.floor(100000 + Math.random() * 900000)); }
async function sendCodeEmail(to, code){
  if (!resendClient) return; // skip silently if not configured
  try {
    await resendClient.emails.send({
      from: EMAIL_FROM,
      to,
      subject: 'Your verification code',
      html: `<p>Your VisualHealth verification code is <b style="font-size:18px">${code}</b>.</p><p>It expires in 10 minutes. If you didn’t request this, you can ignore this email.</p>`
    });
    console.log('sent verification code to', to);
  } catch (e) {
    // Log but do not break user flow
    console.error('send email failed', e?.message || e);
  }
}

async function init() {
  const statements = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto',
    `CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm SMALLINT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_kg REAL',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_media_id UUID',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_display_name_change_at TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_visibility JSONB',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_extras JSONB',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN DEFAULT false',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT',
    `CREATE TABLE IF NOT EXISTS email_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      purpose TEXT NOT NULL CHECK (purpose IN ('verify','reset')),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    'CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id)',
    'CREATE INDEX IF NOT EXISTS email_tokens_purpose_idx ON email_tokens(purpose)'
  ];
  for (const stmt of statements) {
    if (process.env.NODE_ENV === 'test' && stmt.toUpperCase().startsWith('CREATE EXTENSION')) continue;
    await pool.query(stmt);
  }
}

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}

const app = express();
app.use(compression());
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/signup', async (req, res) => {
  try {
    const { email, password, displayName } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
    if (String(password).length < 6) return res.status(400).json({ error: 'password too short' });
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
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

// Start password reset by email
app.post('/password/forgot', async (req, res) => {
  try {
    const email = String(req.body?.email || '').toLowerCase();
    // Always respond ok to avoid user enumeration
    const { rows } = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (rows.length) {
      const userId = rows[0].id;
      const token = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h
      await pool.query('INSERT INTO email_tokens (user_id, token, purpose, expires_at) VALUES ($1,$2,$3,$4)', [userId, token, 'reset', expiresAt]);
      // In dev, expose token to help local testing; in prod integrate mailer
      const dev = process.env.NODE_ENV !== 'production';
      return res.json({ ok: true, devToken: dev ? token : undefined });
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'forgot failed' });
  }
});

// Complete password reset
app.post('/password/reset', async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) return res.status(400).json({ error: 'missing fields' });
    if (String(newPassword).length < 6) return res.status(400).json({ error: 'password too short' });
    const { rows } = await pool.query('SELECT id, user_id, purpose, expires_at, used_at FROM email_tokens WHERE token=$1', [token]);
    if (!rows.length) return res.status(400).json({ error: 'invalid token' });
    const tok = rows[0];
    if (tok.purpose !== 'reset') return res.status(400).json({ error: 'invalid token' });
    if (tok.used_at) return res.status(400).json({ error: 'token used' });
    if (new Date(tok.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'token expired' });
    const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, tok.user_id]);
    await pool.query('UPDATE email_tokens SET used_at=now() WHERE id=$1', [tok.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'reset failed' });
  }
});

// Send verification email/code (for logged-in user)
app.post('/email/send_verification', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing token' });
    const token = auth.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.sub;
    // Fetch email
    const ue = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!ue.rows.length) return res.status(404).json({ error: 'not found' });
    const email = ue.rows[0].email;
    // Rate limit: 60s cooldown and 10/hour
    const rl = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at))) AS since_last,
              COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour_count
         FROM email_tokens WHERE user_id=$1 AND purpose='verify'`,
      [userId]
    );
    const rawSince = rl.rows[0]?.since_last;
    const sinceLast = (rawSince === null || rawSince === undefined) ? Infinity : Number(rawSince);
    const hourCount = Number(rl.rows[0]?.hour_count ?? 0);
    if (sinceLast !== Infinity && !Number.isNaN(sinceLast) && sinceLast < 60) {
      const retrySec = Math.max(1, Math.ceil(60 - sinceLast));
      return res.status(429).json({ error: 'cooldown', retrySec });
    }
    if (hourCount >= 10) return res.status(429).json({ error: 'rate_limited' });
    // Generate and store hashed token
    const code = generate6Code();
    const hashed = sha256(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query('INSERT INTO email_tokens (user_id, token, purpose, expires_at) VALUES ($1,$2,$3,$4)', [userId, hashed, 'verify', expiresAt]);
    // Send real email (best-effort)
    await sendCodeEmail(email, code);
    const dev = process.env.NODE_ENV !== 'production';
    res.json({ ok: true, devToken: dev ? code : undefined });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'send verification failed' });
  }
});

// Verify email using token (link-like)
app.post('/email/verify', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'missing token' });
    const auth = req.headers.authorization || '';
    const hashed = sha256(token);
    let rows;
    if (auth.startsWith('Bearer ')) {
      const jwtTok = auth.slice(7);
      const payload = jwt.verify(jwtTok, JWT_SECRET);
      rows = (await pool.query('SELECT id, user_id, purpose, expires_at, used_at FROM email_tokens WHERE token=$1 AND user_id=$2', [hashed, payload.sub])).rows;
    } else {
      rows = (await pool.query('SELECT id, user_id, purpose, expires_at, used_at FROM email_tokens WHERE token=$1', [hashed])).rows;
    }
    if (!rows.length) return res.status(400).json({ error: 'invalid token' });
    const tok = rows[0];
    if (tok.purpose !== 'verify') return res.status(400).json({ error: 'invalid token' });
    if (tok.used_at) return res.status(400).json({ error: 'token used' });
    if (new Date(tok.expires_at).getTime() < Date.now()) return res.status(400).json({ error: 'token expired' });
    await pool.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [tok.user_id]);
    await pool.query('UPDATE email_tokens SET used_at=now() WHERE id=$1', [tok.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'verify failed' });
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

async function start() {
  await init();
  return app.listen(PORT, () => console.log(`auth-service on :${PORT}`));
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { app, init, pool, start };
