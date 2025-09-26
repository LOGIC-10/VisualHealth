# VisualHealth Platform Reference

## 1. System Overview
- **Purpose**: VisualHealth ingests phonocardiogram recordings, extracts signal features, persists encrypted media, and exposes community features around shared analysis results.
- **Architecture**: Next.js (apps/web) frontend, five Express microservices (auth, media, analysis, feed) plus two FastAPI services (viz, llm). Each service has an isolated Postgres instance.
- **Service-to-service flow**:
  1. Browser calls frontend `/api/*` rewrites, which proxy to internal services (see Section 3.6).
  2. Auth service issues JWTs; other services trust the decoded payload (no signature validation in dev).
  3. Media service encrypts uploaded WAV/PNG using AES-256-GCM and stores blobs; signed URLs allow unauthenticated fetches.
  4. Analysis service stores feature bundles and AI reports, exposes SSE for per-record updates, and coordinates with viz-service for spectrogram caching.
  5. Viz service renders waveform/spectrogram/advanced metrics as PNG or JSON, optionally persisting caches through analysis-service.
  6. Feed service manages posts, likes, bookmarks, comments, and votes, enriching author metadata through auth-service bulk lookup.
  7. LLM service wraps an OpenAI-compatible endpoint, while the Next.js proxy exposes a browser-friendly `/api/llm/chat_stream`.

## 2. Environment & Deployment Handbook
### 2.1 Docker Compose topology
| Service | Image/Build | Host Port | Internal Port | Key Dependencies |
| --- | --- | --- | --- | --- |
| frontend | build ./apps/web | 3000 | 3000 | auth, media, analysis, feed (proxy only) |
| auth-service | build ./services/auth | (dev override 4001) | 4001 | auth-db |
| media-service | build ./services/media | (dev override 4003) | 4003 | media-db, auth-service |
| analysis-service | build ./services/analysis | (dev override 4004) | 4004 | analysis-db, viz-service, llm-service |
| feed-service | build ./services/feed | (dev override 4005) | 4005 | feed-db, auth-service |
| viz-service | build ./services/viz | (dev override 4006) | 4006 | media-service, analysis-service |
| llm-service | build ./services/llm | (dev override 4007) | 4007 | external LLM endpoint |
| *_db | postgres:16-alpine | 5433-5436 (dev override) | 5432 | - |

Use `VISUALHEALTH_INCLUDE_DEV_OVERRIDE=1` with `scripts/start.sh` to include `docker-compose.override.yml`, enabling hot-reload and port exposure.

### 2.2 Essential environment variables
- **Global (front door/Compose)**:
  - `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`: passed into viz and llm containers; required for upstream LLM calls.
  - `RESEND_API_KEY`, `EMAIL_FROM`: configure transactional email for auth service.
- **Frontend (apps/web)**:
  - `NEXT_PUBLIC_API_AUTH`, `NEXT_PUBLIC_API_MEDIA`, `NEXT_PUBLIC_API_ANALYSIS`, `NEXT_PUBLIC_API_FEED`, `NEXT_PUBLIC_API_VIZ`, `NEXT_PUBLIC_API_LLM`: default to `/api/*` rewrites; override for direct browser-to-service access.
- **Auth service**:
  - `DATABASE_URL` (postgres URI), `JWT_SECRET`, `BCRYPT_ROUNDS`, `RESEND_API_KEY`, `EMAIL_FROM`.
- **Media service**:
  - `DATABASE_URL`, `MEDIA_MASTER_KEY_BASE64` (32-byte base64 AES key), `AUTH_BASE` (used for future integrations), `MEDIA_URL_SIGN_SECRET` (falls back to dev constant).
- **Analysis service**:
  - `DATABASE_URL`, `VIZ_BASE` (default `http://viz-service:4006`), `LLM_SVC`, `VIZ_USE_HSMM` ("1" enables HSMM segmentation helpers).
- **Feed service**:
  - `DATABASE_URL`, `AUTH_BASE` (for author enrichment fetches).
- **Viz service**:
  - `PORT`, `MEDIA_BASE`, `ANALYSIS_BASE`, plus LLM variables for delegated tasks.
- **LLM service**:
  - `PORT`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`.

### 2.3 Operational scripts
- `bash scripts/start.sh` - builds (unless `VISUALHEALTH_SKIP_BUILD=1`) and starts all services, tailing logs to `logs/compose_*.log` via background `docker compose logs`.
- `bash scripts/stop.sh` - stops services, detaches log tail.
- `bash scripts/reset.sh` - prompts before `docker compose down -v` (destroys data volumes).
- Optional eval scripts under `scripts/*.py` run offline benchmarking for heart-sound datasets (PhysioNet/CirCor) and persist results in `evals/`.

## 3. API Contracts
### 3.1 Auth Service (`services/auth`, port 4001)
Base URL: `/api/auth/*` via frontend or `http://auth-service:4001/*` inside Compose. JSON responses unless otherwise stated. All authenticated routes require `Authorization: Bearer <JWT>`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness probe `{ ok: true }` |
| POST | `/signup` | none | Create account, returns JWT + user |
| POST | `/login` | none | Authenticate user |
| GET | `/me` | Bearer | Fetch extended profile |
| PATCH | `/me` | Bearer | Update profile fields and extras |
| POST | `/me/password` | Bearer | Change password |
| POST | `/password/forgot` | none | Send reset token (dev returns `devToken`) |
| POST | `/password/reset` | none | Reset password using emailed token |
| POST | `/email/send_verification` | Bearer | Issue 6-digit email verification code |
| POST | `/email/verify` | optional Bearer | Verify email via code (accepts hashed token) |
| POST | `/users/bulk` | none (trusted internal) | Resolve public fields for user IDs |

**Request/Response highlights**
- **`POST /signup`**
  - Body: `{ "email": "user@example.com", "password": "secret>=6", "displayName": "Jane" }`
  - Success: `{ "token": "<JWT>", "user": { "id", "email", "display_name" } }`
  - Errors: `400 invalid email/password`, `409 email already exists`, `500 signup failed`.
- **`POST /login`** mirrors `/signup` response; `401 invalid credentials` on mismatch.
- **`GET /me`** returns profile including demographics, visibility JSON, verification timestamps, and `next_allowed_display_name_change_at` hint. Status `401 invalid token` when decode fails, `404 not found` if user removed.
- **`PATCH /me`** accepts any subset of: `displayName`, `phone`, `birthDate`, `gender`, `heightCm`, `weightKg`, `avatarMediaId`, `visibility` (object), `extras` (object). Enforces 30-day cooldown on display name changes and sane height/weight bounds. Returns updated profile with next display-name timestamp. Errors: `401 missing token`, `429 display name recently changed`, `400 update failed`.
- **Password endpoints** enforce current password validation and minimum length, returning `{ ok: true }` or `400/401` on failure.
- **Email verification**
  - `/email/send_verification` enforces 60s cooldown and 10/hour limit, responding with `{ ok: true, devToken }` in non-production.
  - `/email/verify` accepts raw 6-digit code, hashes via SHA-256, and marks `email_verified_at`. Supports unauthenticated flow for direct links.
- **Bulk lookup** returns `{ "users": [{ "id", "email", "display_name", "avatar_media_id" }] }`, limited to 200 unique IDs, with `400 too many ids` on overflow.

### 3.2 Media Service (`services/media`, port 4003)
Base URL: `/api/media/*`. Stores user-owned encrypted blobs. All CRUD endpoints require Bearer tokens unless accessing signed URLs.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness probe |
| POST | `/upload` | Bearer (multipart) | Upload and encrypt media file |
| GET | `/list` | Bearer | List metadata for user-owned media |
| GET | `/file/:id` | Bearer or signed query | Retrieve and decrypt binary |
| GET | `/file_url/:id` | Bearer | Mint short-lived signed download URL |

**Upload & lifecycle**
- Endpoint expects `multipart/form-data` with field `file`; optional `public` flag (`true`/`false`). 50 MiB size cap via Multer limits. Filenames coerced to UTF-8.
- Mimetype detection attempts (in order): client-provided type, `file-type` sniff, extension via `mime-types`, fallback `application/octet-stream`.
- Stored columns include `filename`, `mimetype`, `size`, random `iv`, `tag`, `ciphertext`, and `is_public` (default `false`). AES-256-GCM key derived from `MEDIA_MASTER_KEY_BASE64`, falling back to a dev constant when misconfigured (warns at startup).
- Response: `{ id, filename, mimetype, size, is_public, created_at }`.

**Download options**
- `GET /file/:id`
  - Owner or flagged public asset: requires valid Bearer token; else use signed URL parameters `uid`, `exp`, `sig`.
  - Signed URL semantics: `exp` is epoch ms (must be in future), `sig = HMAC_SHA256(id.user_id.exp)` using `MEDIA_URL_SIGN_SECRET`. Response sets `Content-Type` and inline `Content-Disposition`.
  - Transparently re-encrypts legacy blobs if decrypting with fallback key succeeds while primary key is present.
- `GET /file_url/:id` returns `{ url, exp }` (5-minute expiry). For private assets, only owner can mint.
- No deletion endpoint is currently exposed; lifecycle managed indirectly via referencing services.

### 3.3 Analysis Service (`services/analysis`, port 4004)
Base URL: `/api/analysis/*`. Handles PCM feature extraction, record persistence, SSE updates, cached AI metadata, and chat transcripts.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness |
| POST | `/analyze` | none | Compute baseline features from PCM array |
| POST | `/records` | Bearer | Persist analysis record metadata |
| GET | `/records` | Bearer | List user records with flags (adv/spec/ai) |
| GET | `/records/:id` | Bearer | Fetch full record including features/adv/ai |
| PATCH | `/records/:id` | Bearer | Update title/adv/spec/ai metadata |
| DELETE | `/records/:id` | Bearer | Delete record |
| GET | `/records/:id/chat` | Bearer | List chat messages scoped to record |
| POST | `/records/:id/chat` | Bearer | Append chat message (`role`: user/assistant) |
| POST | `/records/:id/ai` | Bearer | Save AI report text per language |
| GET | `/records/:id/stream` | Bearer or `access_token` query | Per-record SSE channel (see Section 4.1) |
| GET | `/cache/:hash` | Bearer or `access_token` query | Fetch cached advanced metrics/spec media by signal hash |
| POST | `/cache` | Bearer or `access_token` query | Upsert cached data `{ hash, specMediaId, adv }` |

**Feature analysis (`POST /analyze`)**
- Body: `{ "sampleRate": 4000, "pcm": [0.1, ...] }` (optional `channel`). Returns RMS, zero-crossing rate per second, top envelope peaks, and `peakRatePerSec`.
- Errors: `400 sampleRate and pcm required` or `500 analysis failed`.

**Record persistence**
- `/records` requires `mediaId`, `filename`, `mimetype`, `size`, and `features` (object). Response includes `id` and timestamps.
- `/records/:id` returns full persisted document with `features`, optional `adv` (advanced metrics JSON), `spec_media_id`, and AI payload.
- `/records/:id` PATCH accepts any combination of `title`, `adv`, `specMediaId`, `ai`, `aiGeneratedAt`, `audioHash`. When `adv` or `specMediaId` present, the service:
  - Broadcasts SSE events (`spec_done`, `pcg_done`).
  - If `audioHash` provided, upserts `pcg_cache` for cross-record reuse.

**Cache endpoints** expect SHA-256 hex `hash`. Requests may authenticate via Bearer or `?access_token=<JWT>` (used by viz-service).

**Chat endpoints** enforce record ownership; returns `201` with inserted message and `400` on validation issues.

**AI report persistence** (`POST /records/:id/ai`)
- Body: `{ "lang": "zh", "text": "...", "model": "gpt-4o-mini" }`.
- Returns `{ ok: true, ai: { model, texts: { [lang]: text } }, ai_generated_at }`. Errors: `401 unauthorized`, `404 not found`, `400 text required`.

### 3.4 Feed Service (`services/feed`, port 4005)
Community interactions around posts plus basic social signals. Base URL `/api/feed/*`.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness |
| POST | `/posts` | Bearer | Create post with text and optional media IDs |
| GET | `/posts` | optional Bearer | List latest 100 posts with counts and like flag |
| GET | `/posts/:id` | optional Bearer | Fetch single post with metadata |
| PATCH | `/posts/:id` | Bearer (owner) | Update post content |
| DELETE | `/posts/:id` | Bearer (owner) | Remove post and related rows |
| POST | `/posts/:id/like` | Bearer | Like post (idempotent) |
| DELETE | `/posts/:id/like` | Bearer | Remove like |
| POST | `/posts/:id/bookmark` | Bearer | Bookmark post (no explicit delete endpoint) |
| POST | `/posts/:id/comments` | Bearer | Create comment (optional parentId/mediaIds) |
| GET | `/posts/:id/comments` | optional Bearer | List comments with vote tallies |
| POST | `/comments/:id/vote` | Bearer | Upsert vote with `value` in {-1, 1}; repeat toggles |
| DELETE | `/comments/:id/vote` | Bearer | Clear vote |

**Key behaviors**
- `content` is required for posts/comments; `mediaIds` arrays limited to 12 entries, stored in `post_media`/`comment_media` via indexed order.
- Author resolution: service hits `AUTH_BASE + /users/bulk` to embed `author_display_name` and `author_avatar_media_id`.
- List endpoints compute likes/comments counts and, when authenticated, `liked_by_me` or comment `my_vote` via correlated subqueries.
- Comment tree: `parentId` allows two-level threading (no recursion); service enforces parent existence within same post.
- Vote toggling: posting same value twice removes the vote.

### 3.5 Viz Service (`services/viz`, port 4006)
FastAPI endpoints for server-side waveform rendering, spectrograms, quality heuristics, and advanced PCG analytics. Most endpoints accept raw PCM or a `mediaId` (fetched from media service using optional `Authorization` header). PNG responses include timing headers when compute-intensive.

| Method | Path | Auth | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/waveform_pcm` | none | JSON body with `sampleRate`, `pcm`, optional `startSec`, `endSec`, `width`, `height` | `image/png` waveform thumbnail |
| POST | `/spectrogram_pcm` | optional Bearer | JSON with PCM + optional `maxFreq`, `hash`; optional `Authorization` header forwarded to cache/media | `image/png` spectrogram + `X-Compute-Time` headers; attempts cache fetch via `/analysis/cache` |
| POST | `/features_pcm` | none | PCM JSON | Basic spectral stats JSON |
| POST | `/pcg_quality_pcm` | none | PCM JSON | `{ isHeart, qualityOk, score, issues[], metrics{} }` |
| POST | `/spectrogram_media` | optional Bearer | `{ mediaId, width?, height?, maxFreq? }` | PNG spectrogram |
| POST | `/features_media` | optional Bearer | `{ mediaId }` | Same as `features_pcm` |
| POST | `/pcg_quality_media` | optional Bearer | `{ mediaId }` | Quality JSON (status 400 on fetch/decode error) |
| POST | `/pcg_advanced` | optional Bearer | PCM JSON + `hash?`, `useHsmm?` | Rich clinical-style metrics JSON (see below) |
| POST | `/pcg_advanced_media` | optional Bearer | Accepts flexible payload with `mediaId` or `id`, optional `hash`, `useHsmm` | Internally calls `/pcg_advanced` after media fetch |
| POST | `/hard_algo_metrics` | none | PCM JSON | Raw output from `analyze_pcg_from_pcm` helper |
| POST | `/hard_algo_metrics_media` | optional Bearer | `{ mediaId }` | Same as above |
| POST | `/pcg_segment_hsmm` | none | PCM JSON | HSMM segmentation events/timings |
| POST | `/pcg_segment_hsmm_media` | optional Bearer | `{ mediaId }` | HSMM segmentation after media fetch |

**Advanced metrics schema (partial)**
- Top-level fields: `durationSec`, `hrBpm`, `rrMeanSec`, `rrStdSec`, `systoleMs`, `diastoleMs`, `dsRatio`, `s1DurMs`, `s2DurMs`, `s2SplitMs`, `a2OsMs`, `s1Intensity`, `s2Intensity`, `sysHighFreqEnergy`, `diaHighFreqEnergy`, `sysShape`.
- `qc`: `{ snrDb, motionPct, usablePct, contactNoiseSuspected }`.
- `events`: `s1`/`s2` sample indices (trimmed to 200 entries).
- `extras` contains nested groups: `respiration`, `additionalSounds` probabilities, `murmur` characterization (phase, extent, pitch, grade proxy), `rhythm` heuristics (RR variance, Poincare, sample entropy), HSMM usage flags.
- Response header `X-Compute-Time` (ms). When `hash` present, service attempts to persist `adv` to analysis `/cache` for reuse; callers should reuse consistent hash (e.g., `_sha256_hex_of_floats`).

**Media interactions**
- `_fetch_wav_and_decode` pulls `/media/file/:id` with optional Authorization header and handles WAV decoding via `scipy.io.wavfile`. Errors return JSON `{ "error": "..." }` with 400 status.
- PCM decimated to ~2 kHz for performance; HSMM analysis disabled for clips > 8s when invoked due to runtime constraints.

### 3.6 LLM Service (`services/llm`, port 4007)
FastAPI wrapper around OpenAI-compatible completion API.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/health` | none | `{ ok: true }` |
| POST | `/chat` | depends on upstream | Forwards messages to `chat.completions.create` and returns `{ model, text }` |
| POST | `/chat_sse` | depends on upstream | Streams OpenAI-style events (Section 4.2) |

**`POST /chat`**
- Body: `{ "messages": [{ "role": "user", "content": "..." }, ...], "model": "gpt-4o-mini", "temperature": 0.2 }`. Defaults pulled from env if omitted.
- Errors: `400 LLM not configured` when API key/base URL missing; `400` with upstream error text.

**`POST /chat_sse`**
- Same payload as `/chat`; responds with `text/event-stream`. Each chunk yields `data: {...}\n\n` with `delta` strings, optional `finish_reason`, and terminal `{ done: true, model }` event. Prepends comment `:ok` to establish connection. Errors stream as `{ error: "..." }` JSON.

### 3.7 Frontend Gateway & Proxy Layer (`apps/web`)
#### 3.7.1 Next.js rewrites
The Next.js app rewrites `/api/*` paths to internal services per `next.config.js`:

| Public path | Upstream |
| --- | --- |
| `/api/auth/:path*` | `http://auth-service:4001/:path*` |
| `/api/media/:path*` | `http://media-service:4003/:path*` |
| `/api/analysis/:path*` | `http://analysis-service:4004/:path*` |
| `/api/feed/:path*` | `http://feed-service:4005/:path*` |
| `/api/viz/:path*` | `http://viz-service:4006/:path*` |
| `/api/llm/:path*` | `http://llm-service:4007/:path*` |

These rewrites allow the browser to use same-origin endpoints when frontend runs on port 3000. To bypass proxy (e.g., native mobile), set `NEXT_PUBLIC_API_*` env variables to absolute URLs.

#### 3.7.2 `/api/llm/chat_stream` proxy
Located at `app/api/llm/chat_stream/route.js`.
- `POST /api/llm/chat_stream`
  - Body: same as `llm-service /chat_sse` payload.
  - Response: `{ id }` session identifier stored in memory (`STREAM_SESSIONS` Map, TTL 60s).
- `GET /api/llm/chat_stream?id=...`
  - Streams proxied SSE from `LLM_SERVICE_BASE/chat_sse`. Forwards `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
  - On upstream failure: closes session and returns JSON error (`expired`, `stream unavailable`, etc.).
  - While streaming, any proxy error emits `data: {"error":"stream interrupted"}` before closing.

Frontends (see `app/analysis/[id]/page.jsx`) first POST to obtain `id`, then open `EventSource` to the GET endpoint. Reconnection should restart by POSTing again because sessions are single-use and removed once consumed.

## 4. Streaming & Event Interfaces
### 4.1 Analysis SSE (`GET /analysis/records/:id/stream`)
- **Authentication**: Accepts `Authorization: Bearer <JWT>` header or `?access_token=<JWT>` query parameter (used when embedding in `<iframe>` or service-to-service calls).
- **Handshake**: Responds with headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and an initial comment `: connected` to keep proxies open.
- **Events**: JSON payloads per SSE spec, each terminated by blank line.
  - `event: spec_done` - `data: { "specMediaId": "<uuid>" }`
  - `event: pcg_done` - `data: { "adv": { ...advanced metrics... } }`
- **Retry strategy**: Service does not issue `retry:` hints; clients should implement exponential backoff (e.g., retry after 2s, doubling to max 30s) on connection loss. Because updates are idempotent (persisted in DB), reconnecting after server restarts is safe.
- **Lifecycle**: Connections are cleaned up on client disconnect. Broadcast occurs only when `/records/:id` PATCH updates include `specMediaId` or `adv`.

### 4.2 LLM Streaming
- **Upstream**: `llm-service /chat_sse` yields OpenAI-style chunks `data: { "delta": "partial text" }`. When completion ends, service emits optional `finish_reason` event followed by `data: { "done": true, "model": "..." }`.
- **Frontend proxy**: `/api/llm/chat_stream` simply forwards upstream bytes. If upstream fails or the proxy read loop throws, frontend receives a synthetic chunk `data: { "error": "stream interrupted" }` before the stream closes.
- **Retry guidance**: Browser clients (see `app/analysis/[id]/page.jsx`) treat any error chunk or `EventSource.onerror` as fatal, abort the controller, and allow user to retry. No automatic retry is attempted to avoid duplicate AI prompts.

## 5. Data Model & Schema Notes
### 5.1 Auth database (`users`, `email_tokens`)
- `users`
  - `id UUID PRIMARY KEY`
  - `email TEXT UNIQUE NOT NULL`
  - `password_hash TEXT NOT NULL`
  - `display_name TEXT`, `phone TEXT`, `birth_date DATE`, `gender TEXT`
  - Anthropometrics: `height_cm SMALLINT`, `weight_kg REAL`
  - `avatar_media_id UUID` (points to media-service)
  - `last_display_name_change_at TIMESTAMPTZ`
  - Privacy metadata: `profile_visibility JSONB`, `profile_extras JSONB`
  - Verification flags: `email_verified_at`, `phone_verified_at`, `totp_enabled`, `totp_secret`
  - Timestamps: `created_at NOW()`
- `email_tokens`
  - `id UUID PRIMARY KEY`
  - `user_id UUID REFERENCES users ON DELETE CASCADE`
  - `token TEXT UNIQUE NOT NULL` (hashed for verify codes)
  - `purpose TEXT CHECK IN ('verify','reset')`
  - `expires_at`, `used_at`, `created_at`
  - Indexes on `user_id`, `purpose`

### 5.2 Media database (`media_files`)
- Columns: `id UUID`, `user_id UUID`, `filename TEXT`, `mimetype TEXT`, `size BIGINT`, `iv BYTEA`, `tag BYTEA`, `ciphertext BYTEA`, `is_public BOOLEAN DEFAULT false`, `created_at TIMESTAMPTZ`.
- Index: `idx_media_user` on `(user_id)`.
- Stored data never leaves DB decrypted; downloads reconstitute plaintext on the fly.

### 5.3 Analysis database
- `analysis_records`
  - `id UUID`, `user_id UUID`, `media_id UUID`
  - File metadata: `filename`, `mimetype`, `size`
  - `title TEXT`
  - `features JSONB NOT NULL`
  - Optional extras: `adv JSONB`, `spec_media_id UUID`, `ai JSONB`, `ai_generated_at TIMESTAMPTZ`
  - `created_at TIMESTAMPTZ`
  - Index on `(user_id)`
- `analysis_chat_messages`
  - `id UUID`, `record_id UUID`, `user_id UUID`
  - `role TEXT CHECK (role IN ('user','assistant'))`
  - `content TEXT`, `created_at`
  - Indexes on `(record_id)`, `(user_id)`
- `pcg_cache`
  - `hash TEXT PRIMARY KEY`
  - `spec_media_id UUID`, `adv JSONB`, `created_at`, `updated_at`

### 5.4 Feed database
- `posts`: `id`, `user_id`, `content`, `media_id` (legacy single attachment), `author_name`, `author_email`, `created_at`
- `likes`: composite PK `(user_id, post_id)`
- `bookmarks`: composite PK `(user_id, post_id)`
- `comments`: `id`, `user_id`, `post_id`, `content`, `author_name`, `author_email`, `parent_id UUID`, timestamps
- `post_media`: `(post_id, media_id, idx)` for ordered galleries
- `comment_media`: `(comment_id, media_id, idx)`
- `comment_votes`: `(user_id, comment_id)` with `value SMALLINT CHECK IN (-1,1)`
- Indexes ensure efficient aggregation on `post_id` and `(post_id,parent_id)`.

## 6. Operations, Monitoring & Troubleshooting
- **Health checks**: All services expose `/health` returning `{ ok: true }`. Compose dependencies use them for readiness (manual for now).
- **Logs**: `scripts/start.sh` tails `docker compose logs` into `logs/compose_YYYYMMDD_HHMMSS.log`. Per-service logs include structured JSON lines from Node/Express or Uvicorn.
- **Common failure patterns**
  1. **Media fetch returns `media_error`**: indicates media ID missing or auth header absent. Validate JWT is attached or generate fresh signed URL via `/api/media/file_url/:id`.
  2. **Analysis SSE silent**: ensure client uses Bearer token or `access_token` query; verify `/records/:id` PATCH actually sets `adv`/`specMediaId`. Check container logs for broadcast errors.
  3. **LLM streaming errors**: If frontend receives `stream interrupted`, inspect `llm-service` logs for upstream OpenAI failures. Confirm `LLM_API_KEY`/`LLM_BASE_URL` set.
  4. **Email sending**: Without `RESEND_API_KEY`, auth service continues flow but logs `send email failed`; dev tokens still returned in responses for testing.
  5. **Upload rejection**: `413` or `500 upload failed` typically indicates file exceeding 50 MiB or MIME detection failure. Confirm `multipart/form-data` boundaries and that `file` field is present.
- **Database connectivity**: dev override exposes Postgres on `5433` (auth), `5434` (media), `5435` (feed), `5436` (analysis). Use `psql` for manual inspection.
- **Monitoring hooks**: `X-Compute-Time`, `X-STFT-Time`, `X-Plot-Time` headers from viz endpoints provide quick profiling; automate alerting when compute spikes.
- **Security reminders**: Production deployments should terminate TLS at reverse proxy, enforce JWT signature verification (currently `jwt.decode` only), rotate `MEDIA_MASTER_KEY_BASE64`, and restrict signed URL lifetime as needed.

## 7. Frontend Component & UX Notes (apps/web)
- **Routing**: App Router structure with top-level pages:
  - `/` (landing, hero sections, AI marketing copy).
  - `/auth` (login/signup/reset flows, leverages `dict` entries for i18n).
  - `/onboarding` (profile completion wizard, uploads avatar via media service).
  - `/analyze` (client-side wavesurfer preview, local analysis, optional HSMM toggle stored in `localStorage`).
  - `/analysis` and `/analysis/[id]` (record list/detail, SSE subscription, AI chat panel hitting `/api/llm/chat_stream`).
  - `/analysis/guest` (guest mode view reading cached results from `sessionStorage`).
  - `/community` (feed browsing, forms call `/api/feed/*`).
  - `/settings` (profile updates hitting auth `/me` endpoints).
- **State management**: React hooks only; tokens stored in `localStorage` (`vh_token`). Guest session data persisted via `sessionStorage` (namespaced `vh_guest_*`).
- **Internationalization**: `components/i18n.js` exposes `dict` (currently English copy plus some Simplified Chinese strings inside pages). `useI18n` context selects language; extend by adding locale entry and wrapping pages.
- **API utility**: `lib/api.js` centralizes service base URLs, matching rewrites. `lib/run-local-analysis.js` performs in-browser PCM processing before calling backend.
- **Media handling**: Upload flow attaches Bearer token, stores spectrogram previews in session storage for subsequent detail fetch to avoid re-render delays.
- **UI atoms**: `components/Nav.jsx` scaffolds navigation with login state detection; `components/markdown.js` renders AI outputs.

## 8. Media & Data Lifecycle Guidance
1. **Capture**: User records audio in browser -> local PCM extracted via `runLocalAnalysis`.
2. **Pre-screen**: Client calls `/api/analysis/analyze` for quick metrics; optionally runs `viz` endpoints for local heuristics.
3. **Persist**: Logged-in flow uploads raw audio to `/api/media/upload` (encrypted) and creates `/analysis/records` row pointing to `media_id`.
4. **Post-process**: Spectrogram PNG optionally uploaded as separate media (`spec_media_id`) and attached via `/analysis/records/:id` PATCH.
5. **Advanced metrics**: Either computed client-side and sent as `adv`, or requested from viz `/pcg_advanced(_media)`; results cached by audio hash through analysis `/cache` for reuse across users with identical recordings.
6. **Community sharing**: Feed posts reference `mediaIds` (link to same encrypted assets). Media remain private unless `is_public` set or shared via signed URL. There is currently no automated garbage collection for orphaned media; plan periodic audits using `media_files.created_at` and referencing tables.

## 9. Quick Reference Snippets
- **Generate signed media URL**
  ```bash
  curl -H "Authorization: Bearer $TOKEN" \
    http://localhost:4003/file_url/$MEDIA_ID
  ```
- **Subscribe to analysis SSE**
  ```bash
  curl -N -H "Authorization: Bearer $TOKEN" \
    http://localhost:4004/records/$RECORD_ID/stream
  ```
- **Invoke viz advanced metrics (PCM)**
  ```bash
  curl -X POST http://localhost:4006/pcg_advanced \
    -H "Content-Type: application/json" \
    -d '{ "sampleRate": 2000, "pcm": [0.01, -0.02, ...], "hash": "<sha256>" }'
  ```
- **Start LLM stream via frontend gateway**
  ```bash
  curl -X POST http://localhost:3000/api/llm/chat_stream \
    -H "Content-Type: application/json" \
    -d '{ "messages": [{"role":"user","content":"Summarize the heart sound analysis"}] }'
  # -> { "id": "..." }
  ```

This document captures the current backend contracts, data schemas, operational runbooks, and frontend integration points to support consistent development across VisualHealth microservices.
