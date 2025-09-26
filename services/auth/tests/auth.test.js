import request from 'supertest';
import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

let app;
let pool;
let init;
let originalQuery;
let verificationQueryCount = 0;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => randomUUID(),
    volatility: 'volatile'
  });
  const { Pool } = db.adapters.createPg();
  pool = new Pool();
  globalThis.__AUTH_TEST_POOL__ = pool;
  const mod = await import('../server.js');
  app = mod.app;
  init = mod.init;
  await init();
  originalQuery = pool.query.bind(pool);
  verificationQueryCount = 0;
  pool.query = jest.fn((text, params) => {
    if (typeof text === 'string' && text.includes('SELECT EXTRACT(EPOCH FROM (now() - MAX(created_at)))')) {
      verificationQueryCount += 1;
      if (verificationQueryCount > 1) {
        return Promise.resolve({ rows: [{ since_last: 0, hour_count: 1 }] });
      }
      return Promise.resolve({ rows: [{ since_last: null, hour_count: 0 }] });
    }
    if (typeof text === 'string' && text.trim().startsWith('INSERT INTO email_tokens')) {
      const [userId, token, purpose, expiresAt] = params;
      return originalQuery(
        'INSERT INTO email_tokens (id, user_id, token, purpose, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [randomUUID(), userId, token, purpose, expiresAt]
      );
    }
    if (typeof text === 'string' && text.includes('FROM users WHERE id = ANY')) {
      const ids = Array.isArray(params?.[0]) ? params[0].map((id) => String(id)) : [];
      return (async () => {
        const all = await originalQuery('SELECT id, email, display_name, avatar_media_id FROM users');
        const set = new Set(ids);
        return { rows: all.rows.filter((row) => set.has(row.id)) };
      })();
    }
    return originalQuery(text, params);
  });
});

afterAll(async () => {
  if (originalQuery) {
    pool.query = originalQuery;
  }
  await pool?.end?.();
  delete globalThis.__AUTH_TEST_POOL__;
});

describe('auth-service API', () => {
beforeEach(async () => {
  verificationQueryCount = 0;
  await pool.query('DELETE FROM email_tokens');
  await pool.query('DELETE FROM users');
});

  it('allows signup and stores hashed password', async () => {
    const email = 'test@example.com';
    const res = await request(app)
      .post('/signup')
      .send({ email, password: 'Secret123', displayName: 'Tester' })
      .expect(200);

    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toMatchObject({ email, display_name: 'Tester' });
    const dbUser = await pool.query('SELECT email, password_hash FROM users WHERE email=$1', [email]);
    expect(dbUser.rows).toHaveLength(1);
    expect(dbUser.rows[0].password_hash).not.toBe('Secret123');
  });

  it('rejects login with wrong password and succeeds with correct one', async () => {
    const email = 'login@example.com';
    const password = 'Valid123';
    const hashed = await bcrypt.hash(password, 10);
    const hashRes = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, hashed]
    );
    const userId = hashRes.rows[0].id;

    await request(app)
      .post('/login')
      .send({ email, password: 'wrong' })
      .expect(401);

    const res = await request(app)
      .post('/login')
      .send({ email, password })
      .expect(200);
    expect(res.body.user).toMatchObject({ id: userId, email });
  });

  it('returns profile for /me using bearer token', async () => {
    const email = 'profile@example.com';
    const password = 'Test1234';
    const signup = await request(app)
      .post('/signup')
      .send({ email, password, displayName: 'Profile' })
      .expect(200);
    const token = signup.body.token;

    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.email).toBe(email);
    expect(res.body.next_allowed_display_name_change_at).toBeNull();
  });

  it('allows password change via POST /me/password', async () => {
    const email = 'change@example.com';
    const password = 'Secret123';
    const signup = await request(app)
      .post('/signup')
      .send({ email, password })
      .expect(200);
    const token = signup.body.token;

    await request(app)
      .post('/me/password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: password, newPassword: 'NewSecret456' })
      .expect(200);

    await request(app)
      .post('/login')
      .send({ email, password: 'NewSecret456' })
      .expect(200);
  });

  it('generates dev token for email verification and respects cooldown', async () => {
    const email = 'verify@example.com';
    const signup = await request(app)
      .post('/signup')
      .send({ email, password: 'Secret123' })
      .expect(200);
    const token = signup.body.token;

    const first = await request(app)
      .post('/email/send_verification')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.devToken).toHaveLength(6);

    const second = await request(app)
      .post('/email/send_verification')
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('cooldown');
  });

  it('rejects profile updates when display name change is on cooldown', async () => {
    const email = 'cooldown@example.com';
    const signup = await request(app)
      .post('/signup')
      .send({ email, password: 'Secret123', displayName: 'Initial' })
      .expect(200);
    const token = signup.body.token;
    const userId = signup.body.user.id;

    const now = new Date();
    await pool.query('UPDATE users SET last_display_name_change_at=$1 WHERE id=$2', [now, userId]);

    await request(app)
      .patch('/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ displayName: 'New Name' })
      .expect(429);
  });

  it('completes password reset flow with dev token and rejects reused token', async () => {
    const email = 'forgot@example.com';
    const password = 'Secret123';
    await request(app)
      .post('/signup')
      .send({ email, password })
      .expect(200);

    const forgot = await request(app)
      .post('/password/forgot')
      .send({ email })
      .expect(200);

    expect(forgot.body.ok).toBe(true);
    const devToken = forgot.body.devToken;
    expect(devToken).toBeTruthy();

    await request(app)
      .post('/password/reset')
      .send({ token: devToken, newPassword: 'NewSecret456' })
      .expect(200);

    await request(app)
      .post('/login')
      .send({ email, password: 'NewSecret456' })
      .expect(200);

    // Token cannot be reused
    await request(app)
      .post('/password/reset')
      .send({ token: devToken, newPassword: 'Another789' })
      .expect(400);

    await request(app)
      .post('/login')
      .send({ email, password })
      .expect(401);
  });

  it('hashes verification codes and marks email as verified', async () => {
    const email = 'verify2@example.com';
    const signup = await request(app)
      .post('/signup')
      .send({ email, password: 'Secret123' })
      .expect(200);
    const token = signup.body.token;

    const send = await request(app)
      .post('/email/send_verification')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const code = send.body.devToken;
    expect(code).toHaveLength(6);

    await request(app)
      .post('/email/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: code })
      .expect(200);

    const rows = await pool.query('SELECT email_verified_at FROM users WHERE email=$1', [email]);
    expect(rows.rows[0].email_verified_at).not.toBeNull();

    await request(app)
      .post('/email/verify')
      .set('Authorization', `Bearer ${token}`)
      .send({ token: code })
      .expect(400);
  });

  it('returns limited profile data via bulk lookup and ignores invalid ids', async () => {
    const hash = await bcrypt.hash('Secret123', 10);
    const user1Id = randomUUID();
    const user2Id = randomUUID();
    await originalQuery(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1,$2,$3,$4)',
      [user1Id, 'bulk1@example.com', hash, 'Bulk One']
    );
    await originalQuery(
      'INSERT INTO users (id, email, password_hash, display_name) VALUES ($1,$2,$3,$4)',
      [user2Id, 'bulk2@example.com', hash, 'Bulk Two']
    );

    const res = await request(app)
      .post('/users/bulk')
      .send({ ids: [user1Id, user2Id, null, user1Id] })
      .expect(200);

    expect(res.body.users).toHaveLength(2);
    const emails = res.body.users.map((u) => u.email).sort();
    expect(emails).toEqual(['bulk1@example.com', 'bulk2@example.com']);
  });

  it('rejects impossible birth dates during profile update', async () => {
    const signup = await request(app)
      .post('/signup')
      .send({ email: 'birth-invalid@example.com', password: 'Secret123' })
      .expect(200);
    const token = signup.body.token;

    await request(app)
      .patch('/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ birthDate: '2999-12-31' })
      .expect(400);
  });

  it('limits bulk lookup payload size', async () => {
    const payload = { ids: Array.from({ length: 205 }, () => randomUUID()) };
    await request(app)
      .post('/users/bulk')
      .send(payload)
      .expect(400);
  });

  it('keeps forgot password endpoint constant-time for unknown email', async () => {
    const res = await request(app)
      .post('/password/forgot')
      .send({ email: 'nobody@example.com' })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });
});
