#!/usr/bin/env node
/**
 * Bake the GitHub version lists clients have asked for into the deploy's
 * static assets, so /data/github/{owner}/{repo}/releases.json (and tags.json,
 * assets/{asset}/releases.json) is served without invoking the Worker.
 *
 * The Worker keeps each list in KV: it crawls one on the first request
 * (which misses the static assets and falls through to the Worker) and marks
 * it as demanded. Here, it pages through those lists via
 * /api/admin/github/versions/bake, which refreshes the ones that are due
 * (repos that just released every build, quiet ones a few times a day),
 * re-checks that each repo may still be served, and drops lists nobody has
 * asked for in 30 days. The client contract is docs/github-versions.md.
 *
 * Run after the web build. A failure bakes what it has and exits 0: a list
 * that is not baked is still answered by the Worker.
 *
 * Usage: node scripts/bake-github-versions.js [assetsDir]
 *   assetsDir defaults to web/dist/client; files go under its data/github/.
 *
 * Environment:
 *   API_SECRET               Worker API secret (required, else nothing is baked)
 *   BAKE_API_URL             Defaults to https://mise-versions.jdx.dev
 *   BAKE_REFRESH_SECONDS     Stop asking for refreshes after this long (180)
 *   BAKE_DEADLINE_SECONDS    Stop paging after this long (300)
 *   BAKE_MAX_FILES           Cap on baked files (see MAX_ASSET_FILES)
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(SCRIPT_PATH), "..");
const DEFAULT_API_URL = "https://mise-versions.jdx.dev";
// Workers Paid allows 100,000 static asset files per version. Leave room for
// everything else the build emits (about 1,100 files on 2026-10-14).
export const MAX_ASSET_FILES = 95_000;
const PAGE_LIMIT = 100;
const VALID_PATH =
  /^github\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(releases\.json|tags\.json|assets\/[A-Za-z0-9._+@~-]+\/releases\.json)$/;

export function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

/**
 * Collect every bakeable file from the Worker. Never throws on a failed
 * page: it stops and returns what it has.
 */
export async function collectBakedFiles({
  apiUrl = DEFAULT_API_URL,
  secret,
  fetchImpl = fetch,
  refreshMs = 180_000,
  deadlineMs = 300_000,
  now = () => Date.now(),
  log = console,
}) {
  const started = now();
  const files = [];
  const totals = {
    pages: 0,
    listed: 0,
    unrequested: 0,
    denied: 0,
    refreshed: 0,
    deferred: 0,
    failed: 0,
  };
  let cursor;
  let outOfTokens = false;
  let complete = false;
  while (now() - started < deadlineMs) {
    const refresh = !outOfTokens && now() - started < refreshMs;
    let page;
    for (let attempt = 1; attempt <= 2 && !page; attempt++) {
      // A stalled request or a slow body must not hold up the deploy: both
      // are cancelled when the deadline passes.
      const remaining = deadlineMs - (now() - started);
      if (remaining <= 0) break;
      try {
        const response = await fetchImpl(
          `${apiUrl}/api/admin/github/versions/bake`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${secret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ cursor, limit: PAGE_LIMIT, refresh }),
            signal: AbortSignal.timeout(remaining),
          },
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }
        page = await response.json();
      } catch (error) {
        log.warn(`bake page ${totals.pages + 1} attempt ${attempt}: ${error}`);
      }
    }
    if (!page) break;
    totals.pages++;
    for (const key of Object.keys(page.stats ?? {})) {
      if (key in totals) totals[key] += page.stats[key];
    }
    files.push(...(page.files ?? []));
    outOfTokens ||= page.outOfTokens === true;
    cursor = page.cursor;
    if (!cursor) {
      complete = true;
      break;
    }
  }
  return { files, totals, complete, outOfTokens };
}

/**
 * Write the most recently requested files, up to `maxFiles`, under
 * `assetsDir/data/`. Returns how many were written and dropped.
 */
export function writeBakedFiles(files, { assetsDir, maxFiles }) {
  const dataDir = resolve(assetsDir, "data");
  const valid = files.filter((file) => VALID_PATH.test(file.path));
  const unique = new Map();
  for (const file of valid) unique.set(file.path, file);
  const chosen = [...unique.values()]
    .sort((a, b) => b.requested_at - a.requested_at)
    .slice(0, Math.max(0, maxFiles));
  for (const file of chosen) {
    const target = resolve(dataDir, file.path);
    if (!target.startsWith(dataDir + sep)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body);
  }
  return {
    written: chosen.length,
    invalid: files.length - valid.length,
    overCap: unique.size - chosen.length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const [assetsDir = join(REPO_ROOT, "web/dist/client")] =
    process.argv.slice(2);
  const secret = process.env.API_SECRET;
  if (!secret) {
    console.warn(
      "::warning::API_SECRET is not set; not baking /data/github/ version lists",
    );
    process.exit(0);
  }
  const seconds = (name, fallback) => {
    const value = Number(process.env[name]);
    return (Number.isFinite(value) && value > 0 ? value : fallback) * 1000;
  };
  const existing = countFiles(assetsDir);
  const maxFiles = Math.min(
    Number(process.env.BAKE_MAX_FILES) || Infinity,
    MAX_ASSET_FILES - existing,
  );
  collectBakedFiles({
    apiUrl: process.env.BAKE_API_URL || DEFAULT_API_URL,
    secret,
    refreshMs: seconds("BAKE_REFRESH_SECONDS", 180),
    deadlineMs: seconds("BAKE_DEADLINE_SECONDS", 300),
  })
    .then(({ files, totals, complete, outOfTokens }) => {
      const result = writeBakedFiles(files, { assetsDir, maxFiles });
      console.log(
        `Baked ${result.written} GitHub version lists (${existing} other assets; ` +
          `${totals.refreshed} refreshed, ${totals.deferred} deferred, ` +
          `${totals.failed} failed, ${totals.unrequested} unrequested, ` +
          `${totals.denied} not servable, ${result.overCap} over the cap) ` +
          `in ${totals.pages} pages`,
      );
      if (!complete) {
        console.warn(
          "::warning::Stopped before the end of the GitHub version lists; the rest are served by the Worker until the next deploy",
        );
      }
      if (outOfTokens) {
        console.warn(
          "::warning::The token pool ran out; due GitHub version lists were baked as stored",
        );
      }
      if (result.overCap > 0) {
        console.warn(
          `::warning::${result.overCap} GitHub version lists were left out to stay under the static asset file limit`,
        );
      }
    })
    .catch((error) => {
      console.warn(`::warning::Baking GitHub version lists failed: ${error}`);
    });
}
