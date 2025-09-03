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
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );`);
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
    const { rows } = await pool.query('SELECT id, email, display_name FROM users WHERE id=$1', [payload.sub]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
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
    const { displayName } = req.body || {};
    const { rows } = await pool.query('UPDATE users SET display_name=$1 WHERE id=$2 RETURNING id, email, display_name', [displayName || null, payload.sub]);
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: 'update failed' });
  }
});

init().then(() => app.listen(PORT, () => console.log(`auth-service on :${PORT}`)));
