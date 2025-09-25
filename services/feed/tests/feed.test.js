import request from 'supertest';
import { newDb } from 'pg-mem';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { jest } from '@jest/globals';

let app;
let pool;
let restoreFetch;

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
  globalThis.__FEED_TEST_POOL__ = pool;
  const originalFetch = global.fetch;
  restoreFetch = () => { global.fetch = originalFetch; };
  global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({ users: [] }) }));
  const mod = await import('../server.js');
  app = mod.app;
  await mod.init();
});

afterAll(async () => {
  restoreFetch?.();
  await pool?.end?.();
  delete globalThis.__FEED_TEST_POOL__;
});

describe('feed-service API', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM comment_votes');
    await pool.query('DELETE FROM comment_media');
    await pool.query('DELETE FROM comments');
    await pool.query('DELETE FROM bookmarks');
    await pool.query('DELETE FROM likes');
    await pool.query('DELETE FROM post_media');
    await pool.query('DELETE FROM posts');
  });

  it('supports posting, liking, commenting, and voting', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    const createPost = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Hello community', mediaIds: [randomUUID()] })
      .expect(200);

    const postId = createPost.body.id;

    const list = await request(app)
      .get('/posts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(list.body[0].content).toBe('Hello community');

    await request(app)
      .post(`/posts/${postId}/like`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const liked = await request(app)
      .get('/posts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(liked.body[0].liked_by_me).toBeTruthy();

    await request(app)
      .delete(`/posts/${postId}/like`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const commentRes = await request(app)
      .post(`/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'First!' })
      .expect(200);

    const commentId = commentRes.body.id;

    await request(app)
      .post(`/comments/${commentId}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 1 })
      .expect(200);

    const comments = await request(app)
      .get(`/posts/${postId}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(comments.body[0].my_vote).toBe(1);
  });

  it('enforces auth for bookmarking posts', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    const createPost = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Bookmark me' })
      .expect(200);

    await request(app)
      .post(`/posts/${createPost.body.id}/bookmark`)
      .expect(401);

    await request(app)
      .post(`/posts/${createPost.body.id}/bookmark`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });

  it('rejects comment with invalid parent id', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    const createPost = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Parent test' })
      .expect(200);

    await request(app)
      .post(`/posts/${createPost.body.id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'child', parentId: randomUUID() })
      .expect(400);
  });

  it('toggles comment vote off when same value sent twice', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    const createPost = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Vote toggle' })
      .expect(200);

    const comment = await request(app)
      .post(`/posts/${createPost.body.id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'First comment' })
      .expect(200);

    await request(app)
      .post(`/comments/${comment.body.id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 1 })
      .expect(200)
      .expect({ ok: true, my_vote: 1 });

    await request(app)
      .post(`/comments/${comment.body.id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 1 })
      .expect(200)
      .expect({ ok: true, my_vote: 0 });
  });

  it('rejects invalid vote values', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId }, 'secret');

    const createPost = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Validate votes' })
      .expect(200);

    const comment = await request(app)
      .post(`/posts/${createPost.body.id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Vote me' })
      .expect(200);

    await request(app)
      .post(`/comments/${comment.body.id}/vote`)
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 0 })
      .expect(400)
      .expect({ error: 'invalid value' });
  });

  it('enriches posts with author metadata from auth service', async () => {
    const userId = randomUUID();
    const token = jwt.sign({ sub: userId, email: 'author@example.com' }, 'secret');

    global.fetch.mockImplementation(async (url, options) => {
      if (String(url).endsWith('/me')) {
        return { ok: true, json: async () => ({ email: 'author@example.com', display_name: 'Author Name' }) };
      }
      if (String(url).endsWith('/users/bulk')) {
        const body = JSON.parse(options.body);
        return { ok: true, json: async () => ({ users: body.ids.map((id) => ({ id, email: 'author@example.com', display_name: 'Author Name' })) }) };
      }
      return { ok: false, json: async () => ({ users: [] }) };
    });

    await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'Meta post' })
      .expect(200);

    const list = await request(app)
      .get('/posts')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(list.body[0].author_display_name).toBe('Author Name');
    expect(list.body[0].author_email).toBe('author@example.com');

    global.fetch.mockImplementation(async () => ({ ok: false, json: async () => ({ users: [] }) }));
  });

  it('allows owners to edit posts and blocks others', async () => {
    const ownerId = randomUUID();
    const ownerToken = jwt.sign({ sub: ownerId }, 'secret');
    const outsiderToken = jwt.sign({ sub: randomUUID() }, 'secret');

    const created = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: 'Original content' })
      .expect(200);

    const updated = await request(app)
      .patch(`/posts/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: 'Updated content' })
      .expect(200);
    expect(updated.body.content).toBe('Updated content');

    await request(app)
      .patch(`/posts/${created.body.id}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ content: 'Nope' })
      .expect(404);
  });

  it('enforces ownership on delete', async () => {
    const ownerId = randomUUID();
    const ownerToken = jwt.sign({ sub: ownerId }, 'secret');
    const outsiderToken = jwt.sign({ sub: randomUUID() }, 'secret');

    const created = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ content: 'Delete me' })
      .expect(200);

    await request(app)
      .delete(`/posts/${created.body.id}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .expect(403);

    await request(app)
      .delete(`/posts/${created.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(204);
  });

  it('returns 404 for missing posts', async () => {
    const token = jwt.sign({ sub: randomUUID() }, 'secret');
    await request(app)
      .get(`/posts/${randomUUID()}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
