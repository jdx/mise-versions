import {
  fetchGitHubReleasePage,
  fetchGitHubTagPage,
  githubStatus,
  releaseStaleFallbackAllowed,
  withPoolToken,
  type GitHubListedRelease,
  type GitHubListPage,
  type GitHubTag,
  type TokenRecord,
} from "./mirror";
import { getGitHubLatestReleaseGenerations } from "./release-generation";
import { checkGitHubMirrorAccess } from "./visibility";

// A repository's whole release or tag list, compacted, for mise's version
// listings. The client contract is docs/github-versions.md.

export type VersionsSource = "releases" | "tags";

// Pages of 100 read on a full crawl. Measured 2026-10-14: zed-industries/zed
// has 14 pages of releases, openai/codex 13, kubernetes/kubernetes 9; mise's
// own page cap (10) truncates the first two.
export const VERSIONS_MAX_PAGES = 20;
const PER_PAGE = 100;
const MAX_ENTRIES = VERSIONS_MAX_PAGES * PER_PAGE;
// Pages after the first are fetched up to this many at a time, on one token:
// a Worker has at most 6 connections open at once.
const MAX_PAGE_CONCURRENCY = 6;
// ...and fewer when pages are big, so that about this much JSON is parsed at
// once. A page of 100 releases is 1-8 MB for most repos (cli/cli 3.8 MB,
// astral-sh/uv 7.8 MB) but 32 MB for openai/codex, whose releases carry 100+
// assets; one such page is about what a Worker's 128 MB can parse.
const PARSE_BUDGET_BYTES = 24 * 1024 * 1024;
// A crawl starts no page it does not expect to finish within this long, and
// keeps the newest-first prefix it has as a truncated list. It must fit a background refresh's 30s
// and a client's patience; openai/codex pages take about 8s each.
const CRAWL_BUDGET_MS = 20 * 1000;

// Page 1 (where new releases and tags land) is re-read after a quarter of
// how long the list has been unchanged, within these bounds: every build for a
// repo that just released, a few times a day for a quiet one. For a repo the
// catalog tracks, a published release also rotates its release generation,
// which re-reads page 1 at once whatever the backoff.
const MIN_HEAD_FRESH_MS = 10 * 60 * 1000;
const MAX_HEAD_FRESH_MS = 6 * 60 * 60 * 1000;
const STABLE_FRESH_FRACTION = 4;
// Everything past page 1 (edits, deletions, a tag on an older line) is
// caught by a full re-crawl this often, the mutable-release window.
const FULL_FRESH_MS = 6 * 60 * 60 * 1000;
// Kept well past freshness so a GitHub outage can be bridged.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
// A list nobody has requested for this long is no longer baked or refreshed;
// its KV entry then expires CACHE_TTL_SECONDS after its last write.
export const DEMAND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// `requested_at` is rewritten at most this often.
const DEMAND_RESOLUTION_MS = 24 * 60 * 60 * 1000;
const MIN_EDGE_SECONDS = 60;
// The Worker only answers until the next build bakes the file, so it keeps
// its own answers at the edge briefly.
const MAX_WORKER_EDGE_SECONDS = 10 * 60;

export interface VersionsRelease {
  tag: string;
  /** `published_at`, or `created_at` when GitHub has none. */
  date: string;
  prerelease: boolean;
  asset_count: number;
}

export interface VersionsTag {
  tag: string;
  sha: string;
  /** The tagged commit's committer date. */
  date: string | null;
}

interface VersionsCommon {
  /** When page 1 was last read from GitHub (RFC 3339). */
  fetched_at: string;
  truncated: boolean;
}

export type GitHubVersions =
  | ({ source: "releases"; releases: VersionsRelease[] } & VersionsCommon)
  | ({ source: "tags"; tags: VersionsTag[] } & VersionsCommon);

type StoredRelease = VersionsRelease & { has_asset?: boolean };
type StoredItem = StoredRelease | VersionsTag;

interface StoredVersions {
  /** When page 1 was last read. */
  head_at: number;
  /** When every page was last read. */
  full_at: number;
  /** Since when `items` has been the same. */
  unchanged_since: number;
  /** The release generation page 1 was read under. */
  generation?: string;
  /** When a client last asked for this list (to the day). */
  requested_at?: number;
  items: StoredItem[];
  truncated: boolean;
}

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  DB: D1Database;
  GITHUB_CACHE: KVNamespace;
  GITHUB_VISIBILITY_LIMITER?: RateLimiter;
}

/** A client started too many cold crawls. */
export class VersionsCrawlLimited extends Error {}

/** The pool had no token; a bake does not fall back to anonymous requests. */
class NoPoolToken extends Error {}

/** One list: a repo's releases (optionally only those with an asset) or tags. */
export interface VersionsTarget {
  owner: string;
  repo: string;
  source: VersionsSource;
  /** Releases only: keep only releases carrying an asset of this name. */
  asset?: string;
}

export interface VersionsOptions {
  source: VersionsSource;
  asset?: string;
  /** The repo's current release generation, when the catalog tracks it. */
  generation?: string;
  /** Identifies the caller for the cold-crawl rate limit. */
  clientKey?: string;
  /** Count this request as demand for the list (see DEMAND_WINDOW_MS). */
  demand?: boolean;
}

export interface VersionsResult {
  versions: GitHubVersions;
  /**
   * How long the edge may keep this answer: the rest of its freshness (at
   * most 10 minutes), 60s while it is being refreshed, 0 for a stale
   * fallback.
   */
  edgeSeconds: number;
  staleFallback: boolean;
}

export function validAssetName(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9._+@~-]{1,255}$/.test(value);
}

const REPO_PART = /^[a-z0-9_.-]+$/;

function validLowerRepoPart(value: string | undefined): value is string {
  return !!value && value !== "." && value !== ".." && REPO_PART.test(value);
}

/**
 * The static path of a list, relative to /data/:
 * `github/{owner}/{repo}/releases.json`, `.../tags.json`, or
 * `.../assets/{asset}/releases.json`. Owner and repo are lowercase.
 */
export function versionsPath({
  owner,
  repo,
  source,
  asset,
}: VersionsTarget): string {
  const base = `github/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  if (source === "tags") return `${base}/tags.json`;
  return asset
    ? `${base}/assets/${asset}/releases.json`
    : `${base}/releases.json`;
}

/**
 * The list a /data/github/ path names, or null. Paths are only valid in
 * lowercase, which is how they are baked.
 */
export function parseVersionsPath(path: string): VersionsTarget | null {
  const match = path
    .replace(/[?#].*$/, "")
    .match(
      /^\/?(?:data\/)?github\/([^/]+)\/([^/]+)\/(releases\.json|tags\.json|assets\/([^/]+)\/releases\.json)$/,
    );
  if (!match) return null;
  const [, owner, repo, file, asset] = match;
  if (!validLowerRepoPart(owner) || !validLowerRepoPart(repo)) return null;
  if (asset !== undefined && !validAssetName(asset)) return null;
  return {
    owner,
    repo,
    source: file === "tags.json" ? "tags" : "releases",
    asset,
  };
}

function versionsCacheKey({ owner, repo, source, asset }: VersionsTarget) {
  const repository = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return `github:versions:${source}:${repository}${asset ? `:asset:${asset}` : ""}`;
}

export const VERSIONS_CACHE_PREFIX = "github:versions:";

function parseVersionsCacheKey(key: string): VersionsTarget | null {
  const match = key.match(
    /^github:versions:(releases|tags):([^/:]+)\/([^/:]+)(?::asset:(.+))?$/,
  );
  if (!match) return null;
  const [, source, owner, repo, asset] = match;
  return { owner, repo, source: source as VersionsSource, asset };
}

/**
 * The repository's whole release or tag list. Only call this for a repo that
 * passed the visibility check.
 *
 * With `waitUntil`, a stored list that is due for a refresh is served as is
 * and refreshed in the background, so only a cold miss waits on GitHub (a
 * crawl of openai/codex takes about 20s).
 */
export async function getCachedGitHubVersions(
  env: Env,
  owner: string,
  repo: string,
  options: VersionsOptions,
  { waitUntil }: { waitUntil?: (promise: Promise<unknown>) => void } = {},
): Promise<VersionsResult> {
  const { source, asset } = options;
  const cacheKey = versionsCacheKey({ owner, repo, source, asset });
  const stored = await env.GITHUB_CACHE.get<StoredVersions>(cacheKey, "json");
  const now = Date.now();
  const requestedAt = options.demand ? now : undefined;
  const step = refreshStep(stored, now, source, options.generation);
  if (stored && step === "fresh") {
    if (requestedAt && waitUntil && needsDemandStamp(stored, requestedAt)) {
      waitUntil(stampDemand(env, cacheKey, stored, requestedAt));
    }
    return respond(stored, options, "fresh");
  }
  const refresh = () =>
    refreshVersions(env, owner, repo, cacheKey, options, stored, step, {
      requestedAt,
    });
  if (stored && waitUntil) {
    waitUntil(
      refresh().catch((error) => {
        console.warn(
          `background GitHub versions refresh failed for ${owner}/${repo}:`,
          error,
        );
      }),
    );
    return respond(stored, options, "refreshing");
  }
  // A crawl can be 20 requests; a stream of unique repos or asset names
  // must not turn into a stream of crawls.
  if (!stored && env.GITHUB_VISIBILITY_LIMITER) {
    const { success } = await env.GITHUB_VISIBILITY_LIMITER.limit({
      key: `versions:${options.clientKey ?? "unknown"}`,
    });
    if (!success) throw new VersionsCrawlLimited();
  }
  try {
    return respond(await refresh(), options, "fresh");
  } catch (error) {
    if (stored && releaseStaleFallbackAllowed(error)) {
      return respond(stored, options, "stale");
    }
    throw error;
  }
}

async function refreshVersions(
  env: Env,
  owner: string,
  repo: string,
  cacheKey: string,
  { source, asset, generation }: VersionsOptions,
  stored: StoredVersions | null,
  step: "head" | "full" | "fresh",
  {
    requestedAt,
    requireToken = false,
  }: { requestedAt?: number; requireToken?: boolean } = {},
): Promise<StoredVersions> {
  const result = await withPoolToken(env, async (token) => {
    if (requireToken && !token) throw new NoPoolToken();
    const startedAt = Date.now();
    // A retry is only worth it while there is time to wait for it.
    const fetchPage = (page: number) =>
      fetchPageWithRetry(
        owner,
        repo,
        source,
        asset,
        page,
        token,
        () => Date.now() - startedAt < CRAWL_BUDGET_MS / 2,
      );
    const head = await fetchPage(1);
    // A page 1 with nothing after it is the whole list: a full crawl.
    if (stored && step === "head" && head.hasNextPage) {
      const merged = mergeHead(head, stored);
      if (merged) return { ...merged, full: false };
    }
    return { ...(await crawl(head, fetchPage, startedAt)), full: true };
  });

  const now = Date.now();
  const unchanged =
    !!stored &&
    stored.truncated === result.truncated &&
    JSON.stringify(stored.items) === JSON.stringify(result.items);
  const lastRequested = Math.max(stored?.requested_at ?? 0, requestedAt ?? 0);
  const entry: StoredVersions = {
    head_at: now,
    full_at: result.full || !stored ? now : stored.full_at,
    unchanged_since:
      unchanged && stored ? Math.min(stored.unchanged_since, now) : now,
    generation,
    requested_at: lastRequested || undefined,
    items: result.items,
    truncated: result.truncated,
  };
  await putEntry(env, cacheKey, entry);
  return entry;
}

async function putEntry(
  env: Env,
  cacheKey: string,
  entry: StoredVersions,
): Promise<void> {
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    // The answer stands; the next request reads GitHub again.
    console.warn(`failed to cache GitHub versions ${cacheKey}:`, error);
  }
}

function needsDemandStamp(stored: StoredVersions, at: number): boolean {
  return at - (stored.requested_at ?? 0) >= DEMAND_RESOLUTION_MS;
}

async function stampDemand(
  env: Env,
  cacheKey: string,
  stored: StoredVersions,
  at: number,
): Promise<void> {
  await putEntry(env, cacheKey, { ...stored, requested_at: at });
}

function headFreshMs(stored: StoredVersions): number {
  const stableMs = stored.head_at - stored.unchanged_since;
  return Math.min(
    MAX_HEAD_FRESH_MS,
    Math.max(MIN_HEAD_FRESH_MS, stableMs / STABLE_FRESH_FRACTION),
  );
}

/** When `stored` stops being fresh. */
function freshUntil(stored: StoredVersions): number {
  return Math.min(
    stored.head_at + headFreshMs(stored),
    stored.full_at + FULL_FRESH_MS,
  );
}

function refreshStep(
  stored: StoredVersions | null,
  now: number,
  source: VersionsSource,
  generation?: string,
): "fresh" | "head" | "full" {
  if (!stored || !Array.isArray(stored.items)) return "full";
  if (now - stored.full_at >= FULL_FRESH_MS) return "full";
  // A new generation means the catalog saw a release published.
  if (source === "releases" && stored.generation !== generation) return "head";
  return now < freshUntil(stored) ? "fresh" : "head";
}

/** The response body for a stored list. */
function versionsBody(
  stored: StoredVersions,
  { source, asset }: Pick<VersionsOptions, "source" | "asset">,
): GitHubVersions {
  const fetched_at = new Date(stored.head_at)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  if (source === "tags") {
    return {
      source,
      fetched_at,
      tags: stored.items as VersionsTag[],
      truncated: stored.truncated,
    };
  }
  let releases = stored.items as StoredRelease[];
  if (asset) {
    releases = releases
      .filter((release) => release.has_asset)
      .map(({ has_asset: _hasAsset, ...release }) => release);
  }
  return { source, fetched_at, releases, truncated: stored.truncated };
}

function respond(
  stored: StoredVersions,
  options: VersionsOptions,
  state: "fresh" | "refreshing" | "stale",
): VersionsResult {
  // A list being refreshed is kept at the edge only briefly, so the next
  // request after the refresh reads the new one; a stale fallback not at all.
  const edgeSeconds =
    state === "stale"
      ? 0
      : state === "refreshing"
        ? MIN_EDGE_SECONDS
        : Math.min(
            MAX_WORKER_EDGE_SECONDS,
            Math.max(
              MIN_EDGE_SECONDS,
              Math.ceil((freshUntil(stored) - Date.now()) / 1000),
            ),
          );
  return {
    versions: versionsBody(stored, options),
    edgeSeconds,
    staleFallback: state === "stale",
  };
}

function itemKey(item: StoredItem): string {
  return item.tag;
}

/**
 * Put a fresh page 1 in front of the stored list. The newest entries are on
 * page 1 in both of GitHub's orders (releases by creation, tags by name), so
 * the stored entries after the last page-1 entry it also holds are still
 * right; anything else past page 1 waits for the next full crawl. Returns
 * null when page 1 shares nothing with the stored list.
 */
function mergeHead(
  head: GitHubListPage<StoredItem>,
  stored: StoredVersions,
): { items: StoredItem[]; truncated: boolean } | null {
  const storedIndex = new Map(
    stored.items.map((item, index) => [itemKey(item), index]),
  );
  let anchor = -1;
  for (let i = head.items.length - 1; i >= 0 && anchor < 0; i--) {
    anchor = storedIndex.get(itemKey(head.items[i])) ?? -1;
  }
  if (anchor < 0) return null;
  const headKeys = new Set(head.items.map(itemKey));
  const items = [
    ...head.items,
    ...stored.items
      .slice(anchor + 1)
      .filter((item) => !headKeys.has(itemKey(item))),
  ];
  return {
    items: items.slice(0, MAX_ENTRIES),
    truncated: stored.truncated || items.length > MAX_ENTRIES,
  };
}

/**
 * Every page up to VERSIONS_MAX_PAGES, in GitHub's order, or as many as fit
 * in CRAWL_BUDGET_MS.
 */
async function crawl(
  first: GitHubListPage<StoredItem>,
  fetchPage: (page: number) => Promise<GitHubListPage<StoredItem>>,
  startedAt = Date.now(),
): Promise<{ items: StoredItem[]; truncated: boolean }> {
  const pages = [first];
  // Start another batch only if it should finish in time, judging by how
  // long the last one (at first, page 1) took.
  let lastBatchMs = Date.now() - startedAt;
  const inBudget = () =>
    Date.now() - startedAt + lastBatchMs <= CRAWL_BUDGET_MS;
  const timed = async <T>(batch: Promise<T>): Promise<T> => {
    const batchStart = Date.now();
    const result = await batch;
    lastBatchMs = Date.now() - batchStart;
    return result;
  };
  // A later page GitHub cannot serve ends the list there, as a truncated
  // prefix; only answers such as a rate limit or a 404 fail the crawl.
  let failed = false;
  const tryPage = (page: number) =>
    fetchPage(page).catch((error) => {
      if (!transientError(error)) throw error;
      console.warn(`GitHub list page ${page} failed; truncating:`, error);
      return null;
    });
  const add = (results: (GitHubListPage<StoredItem> | null)[]) => {
    for (const result of results) {
      if (!result) {
        failed = true;
        return;
      }
      pages.push(result);
    }
  };
  if (first.hasNextPage) {
    // GitHub links the last page, so the rest can be read in parallel.
    const known = Math.min(first.lastPage ?? 1, VERSIONS_MAX_PAGES);
    const rest = Array.from(
      { length: Math.max(0, known - 1) },
      (_, i) => i + 2,
    );
    const concurrency = Math.max(
      1,
      Math.min(
        MAX_PAGE_CONCURRENCY,
        Math.floor(PARSE_BUDGET_BYTES / Math.max(1, first.bytes || 0)),
      ),
    );
    for (
      let i = 0;
      i < rest.length && !failed && inBudget();
      i += concurrency
    ) {
      add(
        await timed(Promise.all(rest.slice(i, i + concurrency).map(tryPage))),
      );
    }
  }
  // The list may have grown while it was read, or GitHub sent no last link.
  while (
    !failed &&
    pages[pages.length - 1].hasNextPage &&
    pages.length < VERSIONS_MAX_PAGES &&
    inBudget()
  ) {
    add([await timed(tryPage(pages.length + 1))]);
  }
  // Entries shift down a page when one is added mid-crawl; keep the first.
  const seen = new Set<string>();
  const items = pages
    .flatMap((page) => page.items)
    .filter((item) => {
      const key = itemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { items, truncated: pages[pages.length - 1].hasNextPage };
}

async function fetchPageWithRetry(
  owner: string,
  repo: string,
  source: VersionsSource,
  asset: string | undefined,
  page: number,
  token: TokenRecord | null,
  canRetry: () => boolean = () => true,
): Promise<GitHubListPage<StoredItem>> {
  try {
    return await fetchPage(owner, repo, source, asset, page, token);
  } catch (error) {
    // GitHub times out on some pages of releases with many assets
    // (openai/codex) and answers the same request on a retry.
    if (!transientError(error) || !canRetry()) throw error;
    return fetchPage(owner, repo, source, asset, page, token);
  }
}

/** A timeout, network error or 5xx, rather than an answer. */
function transientError(error: unknown): boolean {
  const status = githubStatus(error);
  return status === null || status >= 500;
}

async function fetchPage(
  owner: string,
  repo: string,
  source: VersionsSource,
  asset: string | undefined,
  page: number,
  token: TokenRecord | null,
): Promise<GitHubListPage<StoredItem>> {
  if (source === "tags") {
    const result = await fetchGitHubTagPage(owner, repo, page, true, token);
    return { ...result, items: result.items.map(compactTag) };
  }
  const result = await fetchGitHubReleasePage(owner, repo, page, token);
  return {
    ...result,
    items: result.items.map((release) => compactRelease(release, asset)),
  };
}

function compactRelease(
  release: GitHubListedRelease,
  asset?: string,
): StoredRelease {
  const compact: StoredRelease = {
    tag: release.tag_name,
    date: release.published_at ?? release.created_at,
    prerelease: release.prerelease,
    asset_count: release.assets.length,
  };
  if (asset) {
    compact.has_asset = release.assets.some((a) => a.name === asset);
  }
  return compact;
}

function compactTag(tag: GitHubTag): VersionsTag {
  return { tag: tag.name, sha: tag.commit.sha, date: tag.date ?? null };
}

interface BakeEnv extends Env {
  ANALYTICS_DB: D1Database;
  GITHUB_MIRROR_ACCESS?: string;
}

export interface BakedFile {
  /** Relative to /data/. */
  path: string;
  /** When a client last asked for this list, epoch ms. */
  requested_at: number;
  body: string;
}

export interface BakePage {
  files: BakedFile[];
  /** Pass back for the next page; null when the listing is done. */
  cursor: string | null;
  stats: {
    listed: number;
    /** Not requested within DEMAND_WINDOW_MS: no longer baked. */
    unrequested: number;
    /** Private, missing, or outside GITHUB_MIRROR_ACCESS: not baked. */
    denied: number;
    refreshed: number;
    /** Due for a refresh, but out of time or tokens: baked as stored. */
    deferred: number;
    failed: number;
  };
  /** The pool ran out of tokens; later pages should not refresh. */
  outOfTokens: boolean;
}

const BAKE_CONCURRENCY = 6;

/**
 * One page of the stored lists, as static files to bake into the next
 * deploy. Lists that are due are refreshed first while `refreshUntil` (epoch
 * ms) has not passed. Static files skip the Worker's access check, so every
 * list's repo is checked again here, as a request would be.
 */
export async function bakeVersionsPage(
  env: BakeEnv,
  {
    cursor,
    limit = 100,
    refreshUntil = 0,
  }: { cursor?: string; limit?: number; refreshUntil?: number },
): Promise<BakePage> {
  const listing = await env.GITHUB_CACHE.list({
    prefix: VERSIONS_CACHE_PREFIX,
    cursor,
    limit: Math.max(1, Math.min(1000, limit)),
  });
  // The bake runs from one client; the per-client lookup limit is for the
  // public routes.
  const accessEnv = { ...env, GITHUB_VISIBILITY_LIMITER: undefined };
  const page: BakePage = {
    files: [],
    cursor: listing.list_complete ? null : listing.cursor,
    stats: {
      listed: listing.keys.length,
      unrequested: 0,
      denied: 0,
      refreshed: 0,
      deferred: 0,
      failed: 0,
    },
    outOfTokens: false,
  };

  const bakeOne = async (key: string) => {
    const target = parseVersionsCacheKey(key);
    if (!target) return;
    const stored = await env.GITHUB_CACHE.get<StoredVersions>(key, "json");
    if (!stored || !Array.isArray(stored.items)) return;
    const now = Date.now();
    if (!stored.requested_at || now - stored.requested_at >= DEMAND_WINDOW_MS) {
      page.stats.unrequested++;
      return;
    }
    const { owner, repo, source, asset } = target;
    if (await checkGitHubMirrorAccess(accessEnv, owner, repo)) {
      page.stats.denied++;
      return;
    }
    const generation =
      source === "releases"
        ? (
            await getGitHubLatestReleaseGenerations(
              env.GITHUB_CACHE,
              owner,
              repo,
            )
          )?.current
        : undefined;
    let entry = stored;
    const step = refreshStep(stored, now, source, generation);
    if (step !== "fresh") {
      if (page.outOfTokens || Date.now() >= refreshUntil) {
        page.stats.deferred++;
      } else {
        try {
          entry = await refreshVersions(
            env,
            owner,
            repo,
            key,
            { source, asset, generation },
            stored,
            step,
            { requireToken: true },
          );
          page.stats.refreshed++;
        } catch (error) {
          if (error instanceof NoPoolToken) {
            page.outOfTokens = true;
            page.stats.deferred++;
          } else {
            page.stats.failed++;
            console.warn(`bake refresh failed for ${key}:`, error);
          }
        }
      }
    }
    page.files.push({
      path: versionsPath(target),
      requested_at: stored.requested_at,
      body: JSON.stringify(versionsBody(entry, { source, asset })),
    });
  };

  const keys = listing.keys.map((key) => key.name);
  for (let i = 0; i < keys.length; i += BAKE_CONCURRENCY) {
    await Promise.all(keys.slice(i, i + BAKE_CONCURRENCY).map(bakeOne));
  }
  return page;
}

/**
 * Count requests for baked files (from Logpush, since they never reach the
 * Worker) as demand, so the lists keep being baked. `paths` are request
 * paths such as `/data/github/cli/cli/releases.json`.
 */
export async function recordVersionsDemand(
  env: Env,
  paths: string[],
  seenAt: number,
): Promise<{ stamped: number; unknown: number }> {
  let stamped = 0;
  let unknown = 0;
  const keys = [
    ...new Set(
      paths.flatMap((path) => {
        const target = parseVersionsPath(path);
        return target ? [versionsCacheKey(target)] : [];
      }),
    ),
  ];
  unknown = paths.length - keys.length;
  for (let i = 0; i < keys.length; i += BAKE_CONCURRENCY) {
    await Promise.all(
      keys.slice(i, i + BAKE_CONCURRENCY).map(async (key) => {
        const stored = await env.GITHUB_CACHE.get<StoredVersions>(key, "json");
        if (!stored || !needsDemandStamp(stored, seenAt)) return;
        await stampDemand(env, key, stored, seenAt);
        stamped++;
      }),
    );
  }
  return { stamped, unknown };
}

export const __testing = {
  crawl,
  mergeHead,
  parseVersionsCacheKey,
  refreshStep,
  versionsCacheKey,
};
