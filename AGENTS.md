# Repository Guidelines

## Project Structure & Module Organization
- Root orchestrates microservices via `docker-compose.yml`.
- `apps/web`: Next.js app (`app/`, `components/`, `public/`).
- `services/*`: backend services — Node.js (`auth`, `media`, `analysis`, `feed`) and Python (`viz`, `llm`).
- `scripts/`: utilities (`start.sh`, `stop.sh`). See ports in `docker-compose.yml` (web: `3000`, auth: `4001`, media: `4003`, analysis: `4004`, feed: `4005`, viz: `4006`, llm: `4007`).

## Build, Test, and Development Commands
- Start all (build + up): `bash scripts/start.sh`
- Stop all: `bash scripts/stop.sh`
- Frontend dev (Docker): `docker compose up frontend -d`
- Frontend dev (local): `cd apps/web && npm install && npm run dev`
- Quick health checks: `curl http://localhost:4001/health` (auth), `http://localhost:4003/health` (media), etc.

## Coding Style & Naming Conventions
- JavaScript/React: 2‑space indent, single quotes, semicolons; PascalCase components (e.g., `Nav.jsx`), Next.js route files as `page.jsx`.
- Python/FastAPI: 4‑space indent, keep endpoints small and pure helpers in modules; prefer type hints where practical.
- Files/folders: kebab‑case for directories, PascalCase for React components.
- Linting/formatting is not configured; match existing style and keep diffs minimal.

## Testing Guidelines
- No formal test suite yet. When adding tests:
  - Web: Playwright E2E under `apps/web/tests/`; unit tests under `apps/web/__tests__/` (Jest).
  - Services (Node): Supertest/Jest under `services/<name>/tests/`.
  - Services (Python): `pytest` under `services/<name>/tests/`.
- Target >80% coverage for new code. Validate core flows after `scripts/start.sh` (e.g., upload, analyze, community posts).

## Commit & Pull Request Guidelines
- Commits follow short prefixes seen in history: `add:`, `fix:`, `update:`, `chore(scope):`.
- Use imperative subject ≤50 chars; body wraps at ~72. Link issues when applicable.
- PRs include: clear summary, affected services, env/DB changes, screenshots for UI, and local verification steps (commands or `curl`).

## Security & Configuration Tips
- Secrets live in `.env` (e.g., `MEDIA_MASTER_KEY_BASE64`, `LLM_*`); never commit secrets or tokens.
- Validate uploads and MIME types; avoid logging JWTs. Review CORS and origins before exposing services.
