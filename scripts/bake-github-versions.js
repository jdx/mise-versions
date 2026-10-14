#!/usr/bin/env node
/**
 * Bake the GitHub version lists clients have asked for into the deploy's
 * static assets, so /data/github/{owner}/{repo}/releases.json (and tags.json,
 * assets/{asset}/releases.json) is served without invoking the Worker.
 *
 * The Worker's refresher (a cron, see web/src/lib/github/versions.ts) keeps
 * the lists fresh in KV, checks their repos' access, and marks every list
 * whose content or bake status changes. This script only copies: it keeps the
 * baked tree between deploys (the deploy workflow caches BAKE_CACHE_DIR) and
 * asks /api/admin/github/versions/changes for the lists changed since the
 * last bake, so a deploy reads KV only for what changed and makes no GitHub
 * requests. Without a cached tree it bakes every list.
 *
 * A failure bakes what it has and exits 0: a list that is not baked is still
 * answered by the Worker.
 *
 * Usage:
 *   node scripts/bake-github-versions.js [assetsDir]
 *     Update the cached tree and copy it under assetsDir/data/github/
 *     (default web/dist/client). Run after the web build.
 *   node scripts/bake-github-versions.js --ack
 *     After the deploy: tell the Worker what was published, so its refresher
 *     dispatches deploys only for later changes.
 *
 * Environment:
 *   API_SECRET             Worker API secret (required, else nothing is baked)
 *   BAKE_API_URL           Defaults to https://mise-versions.jdx.dev
 *   BAKE_CACHE_DIR         Defaults to .cache/github-versions
 *   BAKE_DEADLINE_SECONDS  Stop asking after this long (120)
 *   BAKE_MAX_FILES         Cap on baked files (see MAX_ASSET_FILES)
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(SCRIPT_PATH), "..");
const DEFAULT_API_URL = "https://mise-versions.jdx.dev";
// Workers Paid allows 100,000 static asset files per version. Leave room for
// everything else the build emits (about 1,200 files on 2026-10-14).
export const MAX_ASSET_FILES = 95_000;
const PAGE_LIMIT = 200;
const MANIFEST_VERSION = 1;
// The changes listing comes from KV list(), whose metadata can trail a write
// by up to a minute. Ask again from this long before the last watermark:
// rewriting a few unchanged lists is harmless.
export const SINCE_MARGIN_MS = 10 * 60 * 1000;
const VALID_PATH =
  /^github\/[a-z0-9_.-]+\/[a-z0-9_.-]+\/(releases\.json|tags\.json|assets\/[A-Za-z0-9._+@~-]+\/releases\.json)$/;

export function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return count;
}

/** The cached tree's manifest, or null when there is no usable cache. */
export function readManifest(cacheDir) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(cacheDir, "manifest.json"), "utf8"),
    );
    if (
      manifest?.version !== MANIFEST_VERSION ||
      typeof manifest.watermark !== "number" ||
      typeof manifest.files !== "object" ||
      !existsSync(join(cacheDir, "tree"))
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function writeManifest(cacheDir, manifest) {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "manifest.json"),
    JSON.stringify({ version: MANIFEST_VERSION, ...manifest }),
  );
}

async function post(
  fetchImpl,
  url,
  secret,
  body,
  remainingMs,
  log,
  label,
  attempts = 2,
) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const remaining = remainingMs();
    if (remaining <= 0) return { error: "deadline" };
    // A plain timer rather than AbortSignal.timeout(), whose timer does not
    // keep Node's event loop alive.
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("bake deadline")),
      remaining,
    );
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
      if (response.status === 404) return { notFound: true };
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
      return { page: await response.json() };
    } catch (error) {
      log.warn(`${label} attempt ${attempt}: ${error}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { error: "failed" };
}

/**
 * Every page of /changes since `since` (all baked lists without it).
 * `watermark` is the Worker's clock at the first page. `complete` is false
 * when a page could not be read; `notFound` when the deployed Worker has no
 * such endpoint.
 */
export async function collectChanges({
  apiUrl = DEFAULT_API_URL,
  secret,
  since,
  fetchImpl = fetch,
  deadlineMs = 120_000,
  now = () => Date.now(),
  log = console,
}) {
  const started = now();
  const remainingMs = () => deadlineMs - (now() - started);
  const files = [];
  const deleted = [];
  let watermark;
  let cursor;
  let pages = 0;
  for (;;) {
    const result = await post(
      fetchImpl,
      `${apiUrl}/api/admin/github/versions/changes`,
      secret,
      { since, cursor, limit: PAGE_LIMIT },
      remainingMs,
      log,
      `changes page ${pages + 1}`,
    );
    if (result.notFound && pages === 0) {
      return {
        files,
        deleted,
        watermark,
        pages,
        complete: false,
        notFound: true,
      };
    }
    if (!result.page) {
      return { files, deleted, watermark, pages, complete: false };
    }
    pages++;
    watermark ??= result.page.now;
    files.push(...(result.page.files ?? []));
    deleted.push(...(result.page.deleted ?? []));
    cursor = result.page.cursor;
    if (!cursor) return { files, deleted, watermark, pages, complete: true };
  }
}

/**
 * Every list from the endpoint that came before /changes, for the one deploy
 * whose Worker predates it (the deploy that ships this script runs it
 * against the previous Worker).
 */
export async function collectLegacy({
  apiUrl = DEFAULT_API_URL,
  secret,
  fetchImpl = fetch,
  deadlineMs = 120_000,
  now = () => Date.now(),
  log = console,
}) {
  const started = now();
  const remainingMs = () => deadlineMs - (now() - started);
  const files = [];
  let cursor;
  for (let pages = 1; ; pages++) {
    const result = await post(
      fetchImpl,
      `${apiUrl}/api/admin/github/versions/bake`,
      secret,
      { cursor, limit: 100, refresh: false },
      remainingMs,
      log,
      `legacy bake page ${pages}`,
    );
    if (!result.page) return { files, complete: false };
    files.push(...(result.page.files ?? []));
    cursor = result.page.cursor;
    if (!cursor) return { files, complete: true };
  }
}

function treePath(cacheDir, path) {
  const tree = resolve(cacheDir, "tree");
  const target = resolve(tree, path);
  return VALID_PATH.test(path) && target.startsWith(tree + sep) ? target : null;
}

/**
 * Apply files and deletions to the cached tree (emptied first for a full
 * bake). Returns the manifest's file index, path to requested_at.
 */
export function applyChanges(
  cacheDir,
  { files, deleted = [], full, index = {} },
) {
  if (full) {
    rmSync(join(cacheDir, "tree"), { recursive: true, force: true });
    index = {};
  }
  mkdirSync(join(cacheDir, "tree"), { recursive: true });
  const next = { ...index };
  let written = 0;
  let removed = 0;
  let invalid = 0;
  for (const path of deleted) {
    const target = treePath(cacheDir, path);
    if (!target) {
      invalid++;
      continue;
    }
    if (existsSync(target)) {
      rmSync(target, { force: true });
      removed++;
    }
    delete next[path];
  }
  for (const file of files) {
    const target = treePath(cacheDir, file.path);
    if (!target) {
      invalid++;
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.body);
    next[file.path] = file.requested_at;
    written++;
  }
  return { index: next, written, removed, invalid };
}

/**
 * Copy the most recently requested files of the tree, up to `maxFiles`,
 * under `assetsDir/data/`.
 */
export function publishTree(cacheDir, { assetsDir, index, maxFiles }) {
  const dataDir = resolve(assetsDir, "data");
  const chosen = Object.entries(index)
    .filter(([path]) => treePath(cacheDir, path))
    .sort(([, a], [, b]) => b - a)
    .slice(0, Math.max(0, maxFiles));
  let published = 0;
  for (const [path] of chosen) {
    const source = treePath(cacheDir, path);
    if (!existsSync(source)) continue;
    const target = resolve(dataDir, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
    published++;
  }
  return { published, overCap: Object.keys(index).length - chosen.length };
}

/** Update the cached tree from the Worker and publish it into the build. */
export async function bake({
  assetsDir,
  cacheDir,
  maxFiles = MAX_ASSET_FILES,
  ...options
}) {
  const started = Date.now();
  const manifest = readManifest(cacheDir);
  const since =
    manifest && manifest.watermark > 0
      ? manifest.watermark - SINCE_MARGIN_MS
      : undefined;
  let index = manifest?.files ?? {};
  let watermark = manifest?.watermark ?? 0;
  let mode = since === undefined ? "full" : "incremental";
  let stats;
  const changes = await collectChanges({ ...options, since });
  if (changes.notFound) {
    // The deployed Worker predates /changes. Bake everything it has, and
    // leave the watermark at 0 so the next deploy bakes in full from the new
    // endpoint.
    mode = "legacy";
    const legacy = await collectLegacy(options);
    if (legacy.files.length > 0 || legacy.complete) {
      stats = applyChanges(cacheDir, { files: legacy.files, full: true });
      index = stats.index;
    }
    watermark = 0;
  } else {
    stats = applyChanges(cacheDir, {
      files: changes.files,
      deleted: changes.deleted,
      full: since === undefined && changes.pages > 0,
      index,
    });
    index = stats.index;
    // A bake that stopped part-way keeps its old watermark (a full one, 0),
    // so the next deploy asks again for everything after it.
    if (changes.complete) watermark = changes.watermark;
    else if (since === undefined) watermark = 0;
  }
  writeManifest(cacheDir, { watermark, files: index });
  const published = publishTree(cacheDir, { assetsDir, index, maxFiles });
  return {
    mode,
    complete: mode === "legacy" ? undefined : changes.complete,
    since,
    watermark,
    written: stats?.written ?? 0,
    removed: stats?.removed ?? 0,
    lists: Object.keys(index).length,
    ...published,
    ms: Date.now() - started,
  };
}

/** Tell the Worker that the cached watermark was deployed. */
export async function ack({
  apiUrl = DEFAULT_API_URL,
  secret,
  cacheDir,
  fetchImpl = fetch,
  log = console,
}) {
  const manifest = readManifest(cacheDir);
  if (!manifest || !(manifest.watermark > 0)) return { acked: false };
  const result = await post(
    fetchImpl,
    `${apiUrl}/api/admin/github/versions/baked`,
    secret,
    { watermark: manifest.watermark },
    () => 30_000,
    log,
    "ack",
  );
  return { acked: !!result.page, watermark: manifest.watermark };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  const args = process.argv.slice(2);
  const secret = process.env.API_SECRET;
  const apiUrl = process.env.BAKE_API_URL || DEFAULT_API_URL;
  const cacheDir = resolve(
    process.env.BAKE_CACHE_DIR || join(REPO_ROOT, ".cache/github-versions"),
  );
  if (!secret) {
    console.warn(
      "::warning::API_SECRET is not set; not baking /data/github/ version lists",
    );
    process.exit(0);
  }
  const main = async () => {
    if (args[0] === "--ack") {
      const result = await ack({ apiUrl, secret, cacheDir });
      console.log(
        result.acked
          ? `Acknowledged GitHub version lists baked up to ${new Date(result.watermark).toISOString()}`
          : "No GitHub version-list bake to acknowledge",
      );
      return;
    }
    const assetsDir = args[0] ?? join(REPO_ROOT, "web/dist/client");
    const deadline = Number(process.env.BAKE_DEADLINE_SECONDS);
    const existing = countFiles(assetsDir);
    const maxFiles = Math.min(
      Number(process.env.BAKE_MAX_FILES) || Infinity,
      MAX_ASSET_FILES - existing,
    );
    const result = await bake({
      assetsDir,
      cacheDir,
      maxFiles,
      apiUrl,
      secret,
      deadlineMs:
        (Number.isFinite(deadline) && deadline > 0 ? deadline : 120) * 1000,
    });
    console.log(
      `Baked ${result.published} GitHub version lists (${result.mode}: ` +
        `${result.written} written, ${result.removed} removed; ` +
        `${existing} other assets) in ${(result.ms / 1000).toFixed(1)}s`,
    );
    if (result.complete === false) {
      console.warn(
        "::warning::Stopped before the end of the GitHub version-list changes; the next deploy asks again",
      );
    }
    if (result.overCap > 0) {
      console.warn(
        `::warning::${result.overCap} GitHub version lists were left out to stay under the static asset file limit`,
      );
    }
  };
  main().catch((error) => {
    console.warn(`::warning::Baking GitHub version lists failed: ${error}`);
  });
}
