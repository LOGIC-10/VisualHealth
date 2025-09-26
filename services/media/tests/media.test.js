import request from 'supertest';
import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';

class PassthroughCipher {
  constructor() {
    this.parts = [];
  }

  update(chunk) {
    const buf = Buffer.from(chunk);
    this.parts.push(buf);
    return buf;
  }

  final() {
    return Buffer.alloc(0);
  }

  getAuthTag() {
    return Buffer.alloc(16, 1);
  }
}

class PassthroughDecipher {
  constructor() {
    this.parts = [];
  }

  setAuthTag() {}

  update(chunk) {
    const buf = Buffer.from(chunk);
    this.parts.push(buf);
    return buf;
  }

  final() {
    return Buffer.alloc(0);
  }
}

let app;
let pool;
let init;
let originalQuery;
let cipherSpy;
let decipherSpy;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.MEDIA_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => randomUUID(),
    volatility: 'volatile'
  });
  const { Pool } = db.adapters.createPg();
  pool = new Pool();
  globalThis.__MEDIA_TEST_POOL__ = pool;

  cipherSpy = jest.spyOn(crypto, 'createCipheriv').mockImplementation(() => new PassthroughCipher());
  decipherSpy = jest.spyOn(crypto, 'createDecipheriv').mockImplementation(() => new PassthroughDecipher());

  const mod = await import('../server.js');
  app = mod.app;
  init = mod.init;
  await init();

  originalQuery = pool.query.bind(pool);
  const ensureBuffer = (value) => {
    if (!value) return value;
    if (value instanceof Buffer) return value;
    if (typeof value === 'string') {
      const hex = value.startsWith('\\x') ? value.slice(2) : value;
      return Buffer.from(hex, 'hex');
    }
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return Buffer.from(value);
    return Buffer.from(value);
  };

  pool.query = jest.fn(async (text, params) => {
    const result = await originalQuery(text, params);
    if (result?.rows?.length) {
      for (const row of result.rows) {
        if (row && typeof row === 'object') {
          if (row.iv) row.iv = ensureBuffer(row.iv);
          if (row.tag) row.tag = ensureBuffer(row.tag);
          if (row.ciphertext) row.ciphertext = ensureBuffer(row.ciphertext);
        }
      }
    }
    return result;
  });
});

afterAll(async () => {
  if (originalQuery) {
    pool.query = originalQuery;
  }
  cipherSpy?.mockRestore?.();
  decipherSpy?.mockRestore?.();
  await pool?.end?.();
  delete globalThis.__MEDIA_TEST_POOL__;
});

describe('media-service API', () => {
  const sampleBuffer = Buffer.from('RIFFfakewavdata');
  const filename = 'heart.wav';
  let token;
  let userId;

  beforeEach(() => {
    return pool.query('DELETE FROM media_files');
  });

  beforeEach(() => {
    userId = randomUUID();
    token = jwt.sign({ sub: userId }, 'secret');
  });

  it('rejects unauthenticated upload', async () => {
    await request(app)
      .post('/upload')
      .attach('file', sampleBuffer, filename)
      .expect(401);
  });

  it('handles upload, list, signed url, and download', async () => {
    const uploadRes = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', sampleBuffer, filename)
      .expect(200);

    expect(uploadRes.body.filename).toBe(filename);
    expect(uploadRes.body.mimetype).toMatch(/audio\/wav(e)?/);
    expect(uploadRes.body.is_public).toBe(false);
    const mediaId = uploadRes.body.id;

    const listRes = await request(app)
      .get('/list')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listRes.body[0].id).toBe(mediaId);

    const urlRes = await request(app)
      .get(`/file_url/${mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(urlRes.body.url).toContain(`/file/${mediaId}`);
    expect(typeof urlRes.body.exp).toBe('number');

    const direct = await request(app)
      .get(`/file/${mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, done) => {
        const data = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('end', () => done(null, Buffer.concat(data)));
      })
      .expect(200);
    expect(Buffer.compare(Buffer.from(direct.body), sampleBuffer)).toBe(0);

    // Signed URL grants access without Authorization header
    const signedUrl = new URL(urlRes.body.url);
    const signedPath = `${signedUrl.pathname}${signedUrl.search}`;
    await request(app)
      .get(signedPath)
      .buffer(true)
      .parse((res, done) => {
        const data = [];
        res.on('data', (chunk) => data.push(chunk));
        res.on('end', () => done(null, Buffer.concat(data)));
      })
      .expect(200);
  });

  it('blocks other users from accessing private media', async () => {
    const otherToken = jwt.sign({ sub: randomUUID() }, 'secret');

    const privateUpload = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', sampleBuffer, 'private.wav')
      .expect(200);

    const privateId = privateUpload.body.id;

    await request(app)
      .get(`/file/${privateId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);

    const foreignUrl = await request(app)
      .get(`/file_url/${privateId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(403);
    expect(foreignUrl.body.error).toBe('forbidden');
  });

  it('allows public media to be retrieved by other users', async () => {
    const otherToken = jwt.sign({ sub: randomUUID() }, 'secret');

    const publicUpload = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${token}`)
      .field('public', 'true')
      .attach('file', sampleBuffer, filename)
      .expect(200);

    const mediaId = publicUpload.body.id;

    await request(app)
      .get(`/file/${mediaId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
  });

  it('returns 404 when creating a signed URL for unknown media', async () => {
    const missingId = randomUUID();

    const res = await request(app)
      .get(`/file_url/${missingId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);

    expect(res.body.error).toBe('not found');
  });

  it('sanitizes content-disposition headers for unusual filenames', async () => {
    const uploadRes = await request(app)
      .post('/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', sampleBuffer, filename);

    expect(uploadRes.status).toBe(200);

    const mediaId = uploadRes.body.id;
    const oddName = 'bad"名字.wav';
    await pool.query('UPDATE media_files SET filename=$1 WHERE id=$2', [oddName, mediaId]);

    const res = await request(app)
      .get(`/file/${mediaId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const disposition = res.headers['content-disposition'];
    expect(disposition).toContain('inline; filename="bad__.wav"');
    expect(disposition).toContain("filename*=UTF-8''bad%22%E5%90%8D%E5%AD%97.wav");
    expect(disposition).not.toMatch(/[\r\n]/);
  });

  it('rejects list access without a bearer token', async () => {
    await request(app)
      .get('/list')
      .expect(401)
      .expect({ error: 'unauthorized' });
  });
});
