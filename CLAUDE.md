# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mise-versions is a service that tracks and stores version numbers for tools supported by [mise](https://mise.jdx.dev/). It consists of:

1. **Version collection**: Shell scripts run via GitHub Actions (every 15 min) that fetch versions using `mise ls-remote` in Docker
2. **Version data files**: Plain text version files and TOML files (with timestamps) committed under `docs/`
3. **Web app**: Astro-based frontend deployed to Cloudflare Workers at `mise-versions.jdx.dev`
4. **Analytics API**: Download tracking and statistics via Cloudflare D1 database

## Common Commands

```bash
# Install dependencies
aube install

# Run tests
aube run test              # Run all tests (JS + shell)
aube run test:js           # JS unit tests only
aube run test:shell        # Shell script tests only

# Run a single JS test file
node --test scripts/generate-toml.test.js

# Web development (from web/ directory)
aube --dir web run dev     # Start Astro dev server
aube --dir web run build   # Build for production

# TypeScript checking
aube exec tsc              # Check types (root)
aube --dir web exec tsc    # Check types (web)

# Linting (or use `mise run lint` / `mise run lint:fix`)
aube exec eslint . --ext .ts
oxfmt --check .

# Local development
mise run dev               # or: aube exec wrangler dev

# Deploy
mise run deploy            # builds then deploys
```

## Architecture

### Data Flow

1. **Version Collection** (`scripts/update.sh`):
   - Runs `mise ls-remote <tool>` in Docker for each tool
   - Writes plain text to `docs/<tool>` and TOML with timestamps to `docs/<tool>.toml`
   - Syncs tool metadata to D1 via `scripts/sync-to-d1.js` (reads TOML files + mise commands)
   - Syncs version data to D1 via `scripts/sync-versions-to-d1.js`

2. **Metadata Collection** (`scripts/fetch-metadata.js`, weekly):
   - Fetches license, homepage, authors from GitHub/npm/crates.io/PyPI/RubyGems
   - Syncs directly to D1 via `/api/admin/metadata/sync`

3. **Storage**:
   - **Git repository** (`docs/`): Plain text and TOML version files used as the source for sync jobs and raw GitHub-backed data endpoints
   - **Cloudflare R2** (`DATA_BUCKET`): Binary .gz files only (python-precompiled); deploys also copy them to static `/data/python-precompiled*.gz`
   - **Cloudflare D1** (`ANALYTICS_DB`): Tool metadata, version data, and download analytics

4. **Web Frontend** (`web/`):
   - Astro + Preact + Tailwind
   - Pages: index (tool search), tool detail pages, stats, admin
   - API routes under `web/src/pages/api/`

### Key Files

- `src/analytics/`: Drizzle ORM schema and analytics functions for D1 (schema, tracking, stats, trends, rollups)
- `src/worker.ts`: Custom worker wrapper for scheduled tasks (token-pool observability, update workflow dispatch)
- `.github/workflows/maintenance.yml`: Nightly analytics maintenance; the `scripts/refresh-*-direct.js` scripts roll Analytics Engine events up into the D1 daily and summary tables
- `scripts/refresh-logpush-analytics-direct.js`: Nightly shadow rollup of Cloudflare Logpush `http_requests` logs (R2 bucket `mise-logs`) into `logpush_*` D1 tables: DAU/MAU of every mise client (static asset requests included) and installs from the static `/t` beacon. Each run also checks its runtime, peak RSS and daily log lines against the job's limits (`scripts/lib/logpush-capacity.js`) and emails a warning through Resend when it nears them
- `web/src/lib/data-loader.ts`: Centralized data loading from D1
- `scripts/update.sh`: Main version fetching logic with token management
- `scripts/sync-to-d1.js`: Syncs tool metadata from TOML files to D1
- `scripts/sync-versions-to-d1.js`: Syncs version data to D1
- `scripts/fetch-metadata.js`: Fetches external metadata (license, homepage) and syncs to D1
- `scripts/generate-toml.js`: TOML file generation with timestamp preservation
- `wrangler.jsonc`: Cloudflare Workers configuration (D1, R2, KV bindings)

### D1 Database Schema

The `ANALYTICS_DB` contains:

- `tools`: Tool metadata (name, latest_version, description, backends, etc.)
- `versions`: Per-tool version data with created_at timestamps
- `backends`, `platforms`: Dimension tables that rollups resolve Analytics Engine names against
- Daily rollup tables: `daily_stats`, `daily_combined_stats`, `daily_tool_stats`, `daily_backend_stats`, `daily_tool_backend_stats`, `daily_tool_version_stats`, `daily_tool_platform_stats`, `daily_mau_stats`, `daily_version_stats`
- Summary tables: `tool_download_summaries`, `tool_platform_download_summaries`, `tool_version_download_summaries`, `backend_tool_summaries`, `trending_tool_summaries`

- Logpush shadow tables: `logpush_daily_dau`, `logpush_daily_mau`, and `logpush_daily_*` mirrors of the download rollups, compared against the Analytics Engine numbers before cutover; the site does not read them yet

- mise release downloads: `mise_release_daily_downloads` (per UTC day and `mise.jdx.dev`/`mise.en.dev` release folder `/v<version>/`, binary vs other files) and `mise_release_download_days` (one row per fully covered day), written by the Logpush rollup through `scripts/lib/mise-release-downloads.js` and served by `GET /api/mise-releases/downloads?days=N`, which jdx/mise uses to prune release folders nobody downloads; `/stats` also reads the daily `binary_requests` totals from `mise_release_download_days` to add CDN downloads to the GitHub release-asset downloads in the mise adoption section

Raw download and mise version-request events are written to Cloudflare Analytics Engine (`ANALYTICS_EVENTS`), not D1. Analytics Engine data starts at `ANALYTICS_ENGINE_CUTOVER_DATE`; rollups for earlier dates cannot be recomputed.

## GitHub Token Management

The update workflow uses a token rotation system:

- `TOKEN_MANAGER_URL` / `TOKEN_MANAGER_SECRET`: Cloudflare Worker API for token pool
- `scripts/github-token.js`: Gets tokens, marks rate-limited tokens
- Tokens rotate automatically when rate limited

## GitHub Mirror Snippet

`/api/github/repos/<owner>/<repo>/...` is a GitHub API mirror and most of the Worker's traffic. A free Cloudflare Snippet (`snippets/github-mirror-cache.js`) runs before the Worker on `mise-versions.jdx.dev` and `mise-tools.jdx.dev` and answers cache hits for the effectively immutable endpoints, attestations by digest and releases by exact tag (not `latest`), so those hits never invoke the billed Worker. Everything else, and every miss, goes on to the Worker via `fetch(request)`.

- **Entries**: the Worker (`web/src/lib/github/mirror.ts`, `putGitHubMirrorSnippetCache` / `matchGitHubMirrorSnippetCache`) keeps its edge copy of those 200 responses in `caches.default` under `https://mise-versions.jdx.dev/__snippet-cache/v1/<owner>/<repo>/<attestations|releases>/<digest|tag>` (host and query dropped). Stale fallbacks and errors are never written. Each entry carries `x-mise-mirror-expires-at` (content expiry, the Worker's own edge TTL) and `x-mise-mirror-verified-at` (when GitHub last confirmed the repo public), both epoch seconds, plus `x-mise-cache-control` (the client Cache-Control). The key and response helpers live in the snippet file and the Worker imports them.
- **Private-repo cutoff**: the snippet serves an entry only while `now - verified-at < VISIBILITY_TTL_SECONDS` (1 hour, kept equal to `web/src/lib/github/visibility.ts` by a test). `verified-at` is the time of the GitHub answer the Worker's access check relied on, so a repo that turns private stops being served within the same hour as without the snippet. Past that the request reaches the Worker, which checks access again and rewrites the entry's `verified-at` (never its content expiry). Switching `GITHUB_MIRROR_ACCESS` to `registry` or `off` also takes up to an hour to reach the snippet; for an immediate cutoff remove its rule (below).
- **Debug**: responses carry `x-mise-mirror: snippet` or `x-mise-mirror: worker`.
- **Limits**: 5 ms CPU, 2 MB memory, 32 KB package, no imports; keep it to one cache lookup and header checks.
- **Deploy** (not part of `mise run deploy`; deploy the Worker first so entries exist): `CLOUDFLARE_API_TOKEN=... node scripts/deploy-snippet.js [--dry-run]` uploads the snippet as `github_mirror_cache` and upserts its snippet rule on the `jdx.dev` zone (set `CLOUDFLARE_ZONE_ID` to skip the zone lookup). The rules API replaces all snippet rules, so the script reads them and replaces only its own. **Rollback**: `node scripts/deploy-snippet.js --remove` deletes only its rule.
