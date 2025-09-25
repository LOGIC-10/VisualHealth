import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import jwt from 'jsonwebtoken';
import pkg from 'pg';

const { Pool } = pkg;
const PORT = process.env.PORT || 4005;
const pool = globalThis.__FEED_TEST_POOL__ || new Pool({ connectionString: process.env.DATABASE_URL });
const AUTH_BASE = process.env.AUTH_BASE || 'http://auth-service:4001';

async function init() {
  const baseStatements = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto',
    `CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    content TEXT NOT NULL,
    media_id UUID,
    author_name TEXT,
    author_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
    `CREATE TABLE IF NOT EXISTS likes (
    user_id UUID NOT NULL,
    post_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
  )`,
    `CREATE TABLE IF NOT EXISTS bookmarks (
    user_id UUID NOT NULL,
    post_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
  )`,
    `CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    post_id UUID NOT NULL,
    content TEXT NOT NULL,
    author_name TEXT,
    author_email TEXT,
    parent_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
    `CREATE TABLE IF NOT EXISTS post_media (
    post_id UUID NOT NULL,
    media_id UUID NOT NULL,
    idx INT NOT NULL,
    PRIMARY KEY (post_id, idx)
  )`,
    `CREATE TABLE IF NOT EXISTS comment_media (
    comment_id UUID NOT NULL,
    media_id UUID NOT NULL,
    idx INT NOT NULL,
    PRIMARY KEY (comment_id, idx)
  )`,
    `CREATE TABLE IF NOT EXISTS comment_votes (
    user_id UUID NOT NULL,
    comment_id UUID NOT NULL,
    value SMALLINT NOT NULL CHECK (value IN (-1,1)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, comment_id)
  )`,
    'ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_name TEXT',
    'ALTER TABLE posts ADD COLUMN IF NOT EXISTS author_email TEXT',
    'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_name TEXT',
    'ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_email TEXT',
    'ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id UUID',
    'CREATE INDEX IF NOT EXISTS idx_comments_post_parent ON comments(post_id, parent_id)'
  ];
  for (const stmt of baseStatements) {
    if (process.env.NODE_ENV === 'test' && stmt.toUpperCase().startsWith('CREATE EXTENSION')) continue;
    await pool.query(stmt);
  }
}

function requireUser(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) throw new Error('missing token');
  const token = auth.slice(7);
  const payload = jwt.decode(token);
  if (!payload?.sub) throw new Error('invalid token');
  return payload.sub;
}

async function getAuthorInfo(req) {
  const auth = req.headers.authorization || '';
  let email = null; let name = null;
  try { const payload = jwt.decode((auth.startsWith('Bearer ')? auth.slice(7):auth)); email = payload?.email || null; } catch {}
  try {
    if (auth.startsWith('Bearer ')) {
      const r = await fetch(AUTH_BASE + '/me', { headers: { Authorization: auth } });
      if (r.ok) {
        const j = await r.json();
        name = j?.display_name || j?.email || null;
        email = j?.email || email;
      }
    }
  } catch {}
  if (!name) name = email ? email.split('@')[0] : 'User';
  return { name, email };
}

const app = express();
app.use(compression());
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
    const author = await getAuthorInfo(req);
    const { rows } = await pool.query('INSERT INTO posts (user_id, content, media_id, author_name, author_email) VALUES ($1,$2,$3,$4,$5) RETURNING *', [userId, content, null, author.name, author.email]);
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

app.get('/posts', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    let currentUser = null;
    try { if (auth.startsWith('Bearer ')) currentUser = jwt.decode(auth.slice(7))?.sub || null; } catch {}
    // 1) 先取基础帖子列表
    const { rows } = await pool.query('SELECT * FROM posts ORDER BY created_at DESC LIMIT 100');
    // 2) 在 Node 层补齐聚合与计数，避免 pg-mem 子查询别名限制
    for (const r of rows) {
      const mid = await pool.query('SELECT COALESCE(json_agg(pm.media_id ORDER BY pm.idx), ' + "'[]'" + '::json) AS media_ids FROM post_media pm WHERE pm.post_id=$1', [r.id]);
      r.media_ids = mid.rows[0]?.media_ids || [];
      const likeCnt = await pool.query('SELECT count(*)::int AS c FROM likes WHERE post_id=$1', [r.id]);
      r.likes = likeCnt.rows[0]?.c || 0;
      const cmtCnt = await pool.query('SELECT count(*)::int AS c FROM comments WHERE post_id=$1', [r.id]);
      r.comments = cmtCnt.rows[0]?.c || 0;
      if (currentUser) {
        const liked = await pool.query('SELECT EXISTS(SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2) AS liked', [r.id, currentUser]);
        r.liked_by_me = !!liked.rows[0]?.liked;
      } else {
        r.liked_by_me = false;
      }
    }
    // 3) 富化作者信息，保持单一事实来源
    try {
      const ids = Array.from(new Set(rows.map(r => r.user_id))).filter(Boolean);
      if (ids.length) {
        const resp = await fetch(AUTH_BASE + '/users/bulk', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids }) });
        if (resp.ok) {
          const j = await resp.json();
          const map = new Map((j?.users || []).map(u => [u.id, u]));
          for (const r of rows) {
            const u = map.get(r.user_id);
            if (u) {
              r.author_display_name = u.display_name || u.email || r.author_name || r.author_email || null;
              r.author_avatar_media_id = u.avatar_media_id || null;
              r.author_email = u.email || r.author_email || null;
            }
          }
        }
      }
    } catch {}
    res.json(rows);
  } catch (e) {
    console.error('GET /posts error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.get('/posts/:id', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    let currentUser = null;
    try { if (auth.startsWith('Bearer ')) currentUser = jwt.decode(auth.slice(7))?.sub || null; } catch {}
    // 1) 取基础帖子
    const base = await pool.query('SELECT * FROM posts WHERE id=$1 LIMIT 1', [req.params.id]);
    if (!base.rows.length) return res.status(404).json({ error: 'not found' });
    const row = base.rows[0];
    // 2) 在 Node 层补齐聚合与计数
    const mid = await pool.query('SELECT COALESCE(json_agg(pm.media_id ORDER BY pm.idx), ' + "'[]'" + '::json) AS media_ids FROM post_media pm WHERE pm.post_id=$1', [row.id]);
    row.media_ids = mid.rows[0]?.media_ids || [];
    const likeCnt = await pool.query('SELECT count(*)::int AS c FROM likes WHERE post_id=$1', [row.id]);
    row.likes = likeCnt.rows[0]?.c || 0;
    const cmtCnt = await pool.query('SELECT count(*)::int AS c FROM comments WHERE post_id=$1', [row.id]);
    row.comments = cmtCnt.rows[0]?.c || 0;
    if (currentUser) {
      const liked = await pool.query('SELECT EXISTS(SELECT 1 FROM likes WHERE post_id=$1 AND user_id=$2) AS liked', [row.id, currentUser]);
      row.liked_by_me = !!liked.rows[0]?.liked;
    } else {
      row.liked_by_me = false;
    }
    // Enrich author info
    try {
      const resp = await fetch(AUTH_BASE + '/users/bulk', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids: [row.user_id] }) });
      if (resp.ok) {
        const j = await resp.json();
        const u = (j?.users || [])[0];
        if (u) {
          row.author_display_name = u.display_name || u.email || row.author_name || row.author_email || null;
          row.author_avatar_media_id = u.avatar_media_id || null;
          row.author_email = u.email || row.author_email || null;
        }
      }
    } catch {}
    res.json(row);
  } catch (e) {
    console.error('GET /posts/:id error:', e);
    res.status(500).json({ error: 'server error' });
  }
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

app.delete('/posts/:id/like', async (req, res) => {
  try {
    const userId = requireUser(req);
    await pool.query('DELETE FROM likes WHERE user_id=$1 AND post_id=$2', [userId, req.params.id]);
    res.status(204).end();
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
    const { content, mediaIds, parentId } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    if (mediaIds && mediaIds.length > 12) return res.status(400).json({ error: 'max 12 images' });
    if (parentId) {
      const chk = await pool.query('SELECT 1 FROM comments WHERE id=$1 AND post_id=$2 LIMIT 1', [parentId, req.params.id]);
      if (!chk.rowCount) return res.status(400).json({ error: 'invalid parentId' });
    }
    const author = await getAuthorInfo(req);
    const { rows } = await pool.query('INSERT INTO comments (user_id, post_id, content, author_name, author_email, parent_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [userId, req.params.id, content, author.name, author.email, parentId || null]);
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
  try {
    const auth = req.headers.authorization || '';
    let currentUser = null;
    try { if (auth.startsWith('Bearer ')) currentUser = jwt.decode(auth.slice(7))?.sub || null; } catch {}
    // 1) 取基础评论列表
    const base = await pool.query('SELECT * FROM comments WHERE post_id=$1 ORDER BY created_at ASC', [req.params.id]);
    const rows = base.rows;
    // 2) 在 Node 层补齐聚合、计数与 my_vote
    for (const r of rows) {
      const mid = await pool.query('SELECT COALESCE(json_agg(cm.media_id ORDER BY cm.idx), ' + "'[]'" + '::json) AS media_ids FROM comment_media cm WHERE cm.comment_id=$1', [r.id]);
      r.media_ids = mid.rows[0]?.media_ids || [];
      const up = await pool.query('SELECT count(*)::int AS c FROM comment_votes WHERE comment_id=$1 AND value=1', [r.id]);
      r.up = up.rows[0]?.c || 0;
      const down = await pool.query('SELECT count(*)::int AS c FROM comment_votes WHERE comment_id=$1 AND value=-1', [r.id]);
      r.down = down.rows[0]?.c || 0;
      if (currentUser) {
        const my = await pool.query('SELECT COALESCE(MAX(value),0) AS v FROM comment_votes WHERE comment_id=$1 AND user_id=$2', [r.id, currentUser]);
        r.my_vote = my.rows[0]?.v || 0;
      } else {
        r.my_vote = 0;
      }
    }
    // 3) 富化作者信息
    try {
      const ids = Array.from(new Set(rows.map(r => r.user_id))).filter(Boolean);
      if (ids.length) {
        const resp = await fetch(AUTH_BASE + '/users/bulk', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ ids }) });
        if (resp.ok) {
          const j = await resp.json();
          const map = new Map((j?.users || []).map(u => [u.id, u]));
          for (const r of rows) {
            const u = map.get(r.user_id);
            if (u) {
              r.author_display_name = u.display_name || u.email || r.author_name || r.author_email || null;
              r.author_avatar_media_id = u.avatar_media_id || null;
              r.author_email = u.email || r.author_email || null;
            }
          }
        }
      }
    } catch {}
    res.json(rows);
  } catch (e) {
    console.error('GET /posts/:id/comments error:', e);
    res.status(500).json({ error: 'server error' });
  }
});

// Vote on a comment: value = 1 (up) or -1 (down). Same value toggles off.
app.post('/comments/:id/vote', async (req, res) => {
  try {
    const userId = requireUser(req);
    let { value } = req.body || {};
    value = parseInt(value, 10);
    if (value !== 1 && value !== -1) return res.status(400).json({ error: 'invalid value' });
    const existing = await pool.query('SELECT value FROM comment_votes WHERE user_id=$1 AND comment_id=$2', [userId, req.params.id]);
    if (existing.rowCount && existing.rows[0].value === value) {
      await pool.query('DELETE FROM comment_votes WHERE user_id=$1 AND comment_id=$2', [userId, req.params.id]);
      return res.json({ ok: true, my_vote: 0 });
    }
    await pool.query('INSERT INTO comment_votes (user_id, comment_id, value) VALUES ($1,$2,$3) ON CONFLICT (user_id, comment_id) DO UPDATE SET value=EXCLUDED.value', [userId, req.params.id, value]);
    res.json({ ok: true, my_vote: value });
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

app.delete('/comments/:id/vote', async (req, res) => {
  try {
    const userId = requireUser(req);
    await pool.query('DELETE FROM comment_votes WHERE user_id=$1 AND comment_id=$2', [userId, req.params.id]);
    res.status(204).end();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

// Edit post (owner only)
app.patch('/posts/:id', async (req, res) => {
  try {
    const userId = requireUser(req);
    const { content } = req.body || {};
    if (!content) return res.status(400).json({ error: 'content required' });
    const { rows } = await pool.query('UPDATE posts SET content=$1 WHERE id=$2 AND user_id=$3 RETURNING *', [content, req.params.id, userId]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

// Delete post (owner only), cascade simple tables
app.delete('/posts/:id', async (req, res) => {
  try {
    const userId = requireUser(req);
    const { rows } = await pool.query('SELECT user_id FROM posts WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    if (rows[0].user_id !== userId) return res.status(403).json({ error: 'forbidden' });
    await pool.query('DELETE FROM comment_media WHERE comment_id IN (SELECT id FROM comments WHERE post_id=$1)', [req.params.id]);
    await pool.query('DELETE FROM comments WHERE post_id=$1', [req.params.id]);
    await pool.query('DELETE FROM likes WHERE post_id=$1', [req.params.id]);
    await pool.query('DELETE FROM bookmarks WHERE post_id=$1', [req.params.id]);
    await pool.query('DELETE FROM post_media WHERE post_id=$1', [req.params.id]);
    await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
    res.status(204).end();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
});

async function start() {
  await init();
  return app.listen(PORT, () => console.log(`feed-service on :${PORT}`));
}

if (process.env.NODE_ENV !== 'test') {
  start();
}

export { app, init, pool, start };
