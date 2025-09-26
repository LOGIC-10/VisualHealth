import request from 'supertest';
import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';

let app;
let pool;

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
  globalThis.__ANALYSIS_TEST_POOL__ = pool;
  const mod = await import('../server.js');
  app = mod.app;
  await mod.init();
});

afterAll(async () => {
  await pool?.end?.();
  delete globalThis.__ANALYSIS_TEST_POOL__;
});

describe('analysis-service API', () => {
  const pcmPayload = { sampleRate: 1000, pcm: [0, 0.2, -0.3, 0.1, 0.4] };

  beforeEach(async () => {
    await pool.query('DELETE FROM analysis_chat_messages');
    await pool.query('DELETE FROM analysis_records');
    await pool.query('DELETE FROM pcg_cache');
  });

  it('computes baseline metrics for analyze endpoint', async () => {
    const res = await request(app)
      .post('/analyze')
      .send(pcmPayload)
      .expect(200);
    expect(res.body.sampleRate).toBe(1000);
    expect(res.body.durationSec).toBeCloseTo(pcmPayload.pcm.length / 1000);
    expect(res.body.zcrPerSec).toBeGreaterThanOrEqual(0);
  });

  it('rejects record creation when required fields are missing', async () => {
    const token = jwt.sign({ sub: randomUUID() }, 'secret');

    await request(app)
      .post('/records')
      .set('Authorization', `Bearer ${token}`)
      .send({ mediaId: randomUUID() })
      .expect(400)
      .expect({ error: 'mediaId, filename, mimetype, size, features required' });
  });

  it('supports record lifecycle including cache and AI save', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');
    const baseFeatures = { rms: 0.1, zcr: 5 };
    const recordRes = await request(app)
      .post('/records')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mediaId: randomUUID(),
        filename: 'clip.wav',
        mimetype: 'audio/wav',
        size: 1024,
        features: baseFeatures
      })
      .expect(200);

    const recordId = recordRes.body.id;

    const listRes = await request(app)
      .get('/records')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listRes.body).toHaveLength(1);

    const specId = randomUUID();
    const adv = { hrBpm: 72 };
    const hash = 'a'.repeat(64);
    const patched = await request(app)
      .patch(`/records/${recordId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Updated',
        adv,
        specMediaId: specId,
        audioHash: hash
      })
      .expect(200);
    expect(patched.body.title).toBe('Updated');
    expect(patched.body.adv).toMatchObject(adv);

    const cacheRes = await request(app)
      .get(`/cache/${hash}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(cacheRes.body.adv).toMatchObject(adv);

    await request(app)
      .post(`/records/${recordId}/ai`)
      .set('Authorization', `Bearer ${token}`)
      .send({ lang: 'en', text: 'Clean report', model: 'test-model' })
      .expect(200);

    const detail = await request(app)
      .get(`/records/${recordId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(detail.body.ai.texts.en).toBe('Clean report');
  });

  it('requires auth for listing and deleting records', async () => {
    await request(app)
      .get('/records')
      .expect(401);

    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');
    const record = await request(app)
      .post('/records')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mediaId: randomUUID(),
        filename: 'clip.wav',
        mimetype: 'audio/wav',
        size: 100,
        features: { rms: 0.2 }
      })
      .expect(200);

    await request(app)
      .delete(`/records/${record.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    await request(app)
      .get(`/records/${record.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('supports chat message lifecycle per record', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    const create = await request(app)
      .post('/records')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mediaId: randomUUID(),
        filename: 'chat.wav',
        mimetype: 'audio/wav',
        size: 200,
        features: { rms: 0.2 }
      })
      .expect(200);

    const recordId = create.body.id;

    await request(app)
      .get(`/records/${recordId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect([]);

    const message = await request(app)
      .post(`/records/${recordId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'user', content: 'Hello analysis bot' })
      .expect(201);

    expect(message.body.role).toBe('user');

    const list = await request(app)
      .get(`/records/${recordId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0].content).toBe('Hello analysis bot');

    const finalList = await request(app)
      .get(`/records/${recordId}/chat`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(finalList.body).toHaveLength(1);
  });

  it('rejects patch requests without changes', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');
    const created = await request(app)
      .post('/records')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mediaId: randomUUID(),
        filename: 'empty.wav',
        mimetype: 'audio/wav',
        size: 100,
        features: { rms: 0.1 }
      })
      .expect(200);

    await request(app)
      .patch(`/records/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(400)
      .expect({ error: 'no fields' });
  });

  it('supports cache upsert and retrieval via access token query', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');
    const hash = 'a'.repeat(64);
    const specMediaId = randomUUID();

    const upsert = await request(app)
      .post('/cache')
      .query({ access_token: token })
      .send({ hash, specMediaId, adv: { hrBpm: 70 } })
      .expect(200);
    expect(upsert.body.spec_media_id).toBe(specMediaId);

    const fetched = await request(app)
      .get(`/cache/${hash}`)
      .query({ access_token: token })
      .expect(200);
    expect(fetched.body.spec_media_id).toBe(specMediaId);

    await request(app)
      .post('/cache')
      .query({ access_token: token })
      .send({ hash, adv: { hrBpm: 65 } })
      .expect(200);

    const merged = await request(app)
      .get(`/cache/${hash}`)
      .query({ access_token: token })
      .expect(200);
    expect(merged.body.adv.hrBpm).toBe(65);
  });

  it('requires text when saving AI analysis', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');
    const created = await request(app)
      .post('/records')
      .set('Authorization', `Bearer ${token}`)
      .send({
        mediaId: randomUUID(),
        filename: 'ai.wav',
        mimetype: 'audio/wav',
        size: 100,
        features: { rms: 0.1 }
      })
      .expect(200);

    await request(app)
      .post(`/records/${created.body.id}/ai`)
      .set('Authorization', `Bearer ${token}`)
      .send({ lang: 'en', text: '' })
      .expect(400);
  });

  it('returns 404 for SSE stream when record is missing', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    await request(app)
      .get(`/records/${randomUUID()}/stream`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });

  it('requires authentication for cache lookups', async () => {
    const res = await request(app)
      .get('/cache/abcd')
      .expect(400);
    expect(res.body.error).toBe('cache get failed');
  });
});
