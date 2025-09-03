import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

const { Pool } = pkg;
const PORT = process.env.PORT || 4005;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function init() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto; 
  CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    content TEXT NOT NULL,
    media_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS likes (
    user_id UUID NOT NULL,
    post_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id UUID NOT NULL,
    post_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
  );
  CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    post_id UUID NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS post_media (
    post_id UUID NOT NULL,
    media_id UUID NOT NULL,
    idx INT NOT NULL,
    PRIMARY KEY (post_id, idx)
  );
  CREATE TABLE IF NOT EXISTS comment_media (
    comment_id UUID NOT NULL,
    media_id UUID NOT NULL,
    idx INT NOT NULL,
    PRIMARY KEY (comment_id, idx)
  );
  `);
}

function requireUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('missing token');
  const token = auth.slice(7);
  const payload = jwt.decode(token);
  if (!payload?.sub) throw new Error('invalid token');
  return payload.sub;
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/posts', async (req, res) => {
  try {
    const userId = requireUser(req);
    const { content, mediaIds } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    if (mediaIds && mediaIds.length > 12) return res.status(400).json({ error: 'max 12 images' });
    const { rows } = await pool.query('INSERT INTO posts (user_id, content, media_id) VALUES ($1,$2,$3) RETURNING *', [userId, content, null]);
    const post = rows[0];
    if (Array.isArray(mediaIds)) {
      for (let i = 0; i < Math.min(mediaIds.length, 12); i++) {
        await pool.query('INSERT INTO post_media (post_id, media_id, idx) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [post.id, mediaIds[i], i]);
      }
    }
    res.json({ ...post, media_ids: mediaIds || [] });
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.get('/posts', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, 
      COALESCE((SELECT json_agg(pm.media_id ORDER BY pm.idx) FROM post_media pm WHERE pm.post_id=p.id), '[]'::json) AS media_ids,
      (SELECT count(*)::int FROM likes l WHERE l.post_id=p.id) AS likes,
      (SELECT count(*)::int FROM comments c WHERE c.post_id=p.id) AS comments
    FROM posts p ORDER BY created_at DESC LIMIT 100`);
  res.json(rows);
});

app.get('/posts/:id', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, 
      COALESCE((SELECT json_agg(pm.media_id ORDER BY pm.idx) FROM post_media pm WHERE pm.post_id=p.id), '[]'::json) AS media_ids,
      (SELECT count(*)::int FROM likes l WHERE l.post_id=p.id) AS likes,
      (SELECT count(*)::int FROM comments c WHERE c.post_id=p.id) AS comments
    FROM posts p WHERE p.id=$1 LIMIT 1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

app.post('/posts/:id/like', async (req, res) => {
  try {
    const userId = requireUser(req);
    await pool.query('INSERT INTO likes (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.post('/posts/:id/bookmark', async (req, res) => {
  try {
    const userId = requireUser(req);
    await pool.query('INSERT INTO bookmarks (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.post('/posts/:id/comments', async (req, res) => {
  try {
    const userId = requireUser(req);
    const { content, mediaIds } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    if (mediaIds && mediaIds.length > 12) return res.status(400).json({ error: 'max 12 images' });
    const { rows } = await pool.query('INSERT INTO comments (user_id, post_id, content) VALUES ($1,$2,$3) RETURNING *', [userId, req.params.id, content]);
    const comment = rows[0];
    if (Array.isArray(mediaIds)) {
      for (let i = 0; i < Math.min(mediaIds.length, 12); i++) {
        await pool.query('INSERT INTO comment_media (comment_id, media_id, idx) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [comment.id, mediaIds[i], i]);
      }
    }
    res.json({ ...comment, media_ids: mediaIds || [] });
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.get('/posts/:id/comments', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*, COALESCE((SELECT json_agg(cm.media_id ORDER BY cm.idx) FROM comment_media cm WHERE cm.comment_id=c.id), '[]'::json) AS media_ids
    FROM comments c WHERE c.post_id=$1 ORDER BY created_at ASC`, [req.params.id]);
  res.json(rows);
});

init().then(() => app.listen(PORT, () => console.log(`feed-service on :${PORT}`)));
