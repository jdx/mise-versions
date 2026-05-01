# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

mise-versions is a service that tracks and stores version numbers for tools supported by [mise](https://mise.jdx.dev/). It consists of:

1. **Version collection**: Shell scripts run via GitHub Actions (every 15 min) that fetch versions using `mise ls-remote` in Docker
2. **Static hosting**: Plain text version files and TOML files (with timestamps) served via GitHub Pages at `mise.jdx.dev/<tool>`
3. **Web app**: Astro-based frontend deployed to Cloudflare Workers at `mise-tools.jdx.dev`
4. **Analytics API**: Download tracking and statistics via Cloudflare D1 database

## Common Commands

```bash
# Install dependencies
npm install

# Run tests
bun run test               # Run all tests (JS + shell)
bun run test:js            # JS unit tests only
bun run test:shell         # Shell script tests only

# Run a single JS test file
node --test scripts/generate-toml.test.js

# Web development (from web/ directory)
cd web && npm run dev      # Start Astro dev server
cd web && npm run build    # Build for production

# TypeScript checking
bunx tsc                   # Check types (root)
cd web && bunx tsc         # Check types (web)

# Linting (or use `mise run lint` / `mise run lint:fix`)
bunx eslint . --ext .ts
bunx prettier --check .

# Local development
mise run dev               # or: bunx wrangler dev

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
   - **GitHub Pages** (`docs/`): Plain text version files for `mise.jdx.dev/<tool>`
   - **Cloudflare R2** (`DATA_BUCKET`): Binary .gz files only (python-precompiled)
   - **Cloudflare D1** (`ANALYTICS_DB`): Tool metadata, version data, and download analytics

4. **Web Frontend** (`web/`):
   - Astro + Preact + Tailwind
   - Pages: index (tool search), tool detail pages, stats, admin
   - API routes under `web/src/pages/api/`

### Key Files

- `src/analytics/`: Drizzle ORM schema and analytics functions for D1 (schema, tracking, stats, trends, rollups)
- `src/worker.ts`: Custom worker wrapper for scheduled tasks (daily rollups, maintenance)
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
- `downloads`: Raw download tracking
- `downloads_daily`: Aggregated historical data (90+ days old)
- Rollup tables: `daily_stats`, `daily_tool_stats`, `daily_backend_stats`
- `version_requests`: DAU/MAU tracking for mise CLI

## GitHub Token Management

The update workflow uses a token rotation system:

- `TOKEN_MANAGER_URL` / `TOKEN_MANAGER_SECRET`: Cloudflare Worker API for token pool
- `scripts/github-token.js`: Gets tokens, marks rate-limited tokens
- Tokens rotate automatically when rate limited
