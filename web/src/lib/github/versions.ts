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
import { readGitHubLatestReleaseGenerations } from "./release-generation";
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
// A crawl starts no page it does not expect to finish within `budgetMs`, and
// keeps the newest-first prefix it has as a truncated list. Requests still
// open at `deadlineMs` are cancelled, keeping the pages before the first
// unfinished one. Both must fit a background refresh's 30s and a client's
// patience; openai/codex pages take about 8s each.
const crawlTiming = {
  budgetMs: 20 * 1000,
  deadlineMs: 25 * 1000,
  coldWaitMs: 1500,
};
// A crawl starts with the newest PROBE_PER_PAGE entries. That read is small
// (cli/cli: 0.4s and 0.8 MB, where a page of 100 is 2.8s and 3.8 MB), and its
// `rel="last"` link gives the exact number of pages, so all of them can be
// read at once instead of after page 1. A second probe at the end checks the
// pages join up. A cold request waits `coldWaitMs` for the whole list, then
// is answered with the probe's entries (truncated) while the crawl finishes
// in the background: mise's prefer-offline commands (shims, `mise x`) give a
// lookup one 3s attempt.
const PROBE_PER_PAGE = 20;

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
// Demand is kept under its own key, so stamping it never rewrites a list
// that a refresh may be saving at the same moment. It outlives the window
// by a few days and then expires by itself.
const DEMAND_PREFIX = "github:versions-demand:";
const DEMAND_TTL_SECONDS = (DEMAND_WINDOW_MS + 5 * 24 * 60 * 60 * 1000) / 1000;
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
  items: StoredItem[];
  truncated: boolean;
}

/**
 * Each list's state, kept as the KV metadata of its entry, so the refresher
 * and the bake read every list's state with one `list()` call per 1,000
 * lists instead of reading each list. (A Worker may make 1,000 KV
 * operations per invocation.)
 */
export interface ListMeta {
  /** When the list's content or bake status last changed (epoch ms). */
  c: number;
  /** Whether the list is baked: requested lately, and its repo servable. */
  b: boolean;
  /** When the repo's access was last checked. */
  a: number;
  /** head_at, full_at and unchanged_since of the entry. */
  h: number;
  f: number;
  u: number;
  /** The release generation page 1 was read under. */
  g?: string;
  /** When a client last asked for the list, as last copied here. */
  r?: number;
  /** GitHub's ETag for the probe, for a conditional refresh. */
  e?: string;
}

function parseMeta(value: unknown): ListMeta | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Partial<ListMeta>;
  return typeof meta.c === "number" &&
    typeof meta.b === "boolean" &&
    typeof meta.a === "number" &&
    typeof meta.h === "number" &&
    typeof meta.f === "number" &&
    typeof meta.u === "number"
    ? (meta as ListMeta)
    : null;
}

/** The freshness fields refreshStep needs, from a list's metadata. */
function freshnessOf(meta: ListMeta): StoredVersions {
  return {
    head_at: meta.h,
    full_at: meta.f,
    unchanged_since: meta.u,
    generation: meta.g,
    items: [],
    truncated: false,
  };
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
  const { value: stored, metadata } =
    await env.GITHUB_CACHE.getWithMetadata<StoredVersions>(cacheKey, "json");
  const meta = parseMeta(metadata);
  const now = Date.now();
  if (options.demand) {
    const stamping = stampDemand(env, cacheKey, now);
    if (waitUntil) waitUntil(stamping);
    else await stamping;
  }
  const step = refreshStep(stored, now, source, options.generation);
  if (stored && step === "fresh") {
    return respond(stored, options, "fresh");
  }
  const refresh = () =>
    refreshVersions(env, owner, repo, cacheKey, options, stored, step, {
      meta,
    }).then(({ entry }) => entry);
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
  if (!stored && waitUntil) {
    return coldVersions(env, owner, repo, cacheKey, options, waitUntil);
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

/**
 * A list nobody has asked for yet. Waits `coldWaitMs` for the whole list;
 * if the crawl takes longer, answers with the longest newest-first prefix it
 * has read so far (page 1 if it is in, else the probe) as a truncated list,
 * briefly cached, and lets the crawl finish and store the whole list in the
 * background.
 */
async function coldVersions(
  env: Env,
  owner: string,
  repo: string,
  cacheKey: string,
  options: VersionsOptions,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<VersionsResult> {
  let best: GitHubListPage<StoredItem> | undefined;
  let prefixed: () => void = () => {};
  const prefix = new Promise<void>((resolve) => {
    prefixed = resolve;
  });
  const refreshing = refreshVersions(
    env,
    owner,
    repo,
    cacheKey,
    options,
    null,
    "full",
    {
      onPrefix: (page) => {
        if (!best || page.items.length > best.items.length) best = page;
        prefixed();
      },
    },
  );
  const settled = refreshing.then(
    ({ entry }) => ({ entry }) as const,
    (error: unknown) => ({ error }) as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), crawlTiming.coldWaitMs);
  });
  let first = await Promise.race([settled, waited]);
  clearTimeout(timer);
  if (first === null) {
    const next = await Promise.race([
      settled,
      prefix.then(() => ({ page: best! }) as const),
    ]);
    if ("page" in next) {
      waitUntil(
        refreshing.catch((error) => {
          console.warn(
            `background GitHub versions crawl failed for ${owner}/${repo}:`,
            error,
          );
        }),
      );
      const now = Date.now();
      const partial: StoredVersions = {
        head_at: now,
        full_at: 0,
        unchanged_since: now,
        items: next.page.items,
        truncated: next.page.hasNextPage,
      };
      return respond(partial, options, "refreshing");
    }
    first = next;
  }
  if ("error" in first) throw first.error;
  return respond(first.entry, options, "fresh");
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
    requireToken = false,
    onPrefix,
    meta = null,
  }: {
    requireToken?: boolean;
    /**
     * The list's metadata as read. Absent for a new list, which the caller
     * has just checked for access (a request) and so is bakeable.
     */
    meta?: ListMeta | null;
    /**
     * Called with each newest-first page as soon as it is read (the probe,
     * then page 1), for an answer that cannot wait for the whole list.
     */
    onPrefix?: (page: GitHubListPage<StoredItem>) => void;
  } = {},
): Promise<{ entry: StoredVersions; meta: ListMeta; changed: boolean }> {
  const result = await withPoolToken(env, async (token) => {
    if (requireToken && !token) throw new NoPoolToken();
    const startedAt = Date.now();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error("GitHub crawl deadline")),
      crawlTiming.deadlineMs,
    );
    try {
      // A retry is only worth it while there is time to wait for it.
      const canRetry = () =>
        !deadline.signal.aborted &&
        Date.now() - startedAt < crawlTiming.budgetMs / 2;
      const fetchPage = (
        page: number,
        perPage = PER_PAGE,
        ifNoneMatch?: string,
      ) =>
        fetchPageWithRetry(
          owner,
          repo,
          source,
          asset,
          page,
          token,
          deadline.signal,
          canRetry,
          perPage,
          ifNoneMatch,
        );
      const reprobe = () => fetchPage(1, PROBE_PER_PAGE);
      if (stored && step === "head") {
        // Conditional on the last probe's ETag: an unchanged probe is a 304,
        // which costs no rate limit and no parsing.
        const probe = await fetchPage(1, PROBE_PER_PAGE, meta?.e);
        if (probe.notModified) {
          return {
            items: stored.items,
            truncated: stored.truncated,
            full: false,
            etag: probe.etag,
          };
        }
        onPrefix?.(probe);
        // A probe with nothing after it is the whole list: a full crawl.
        if (!probe.hasNextPage) {
          return {
            items: probe.items,
            truncated: false,
            full: true,
            etag: probe.etag,
          };
        }
        const merged = mergeHead(probe, stored);
        if (merged) return { ...merged, full: false, etag: probe.etag };
        return await verifiedCrawl(probe, fetchPage, reprobe, startedAt);
      }
      // A full crawl needs page 1 unless the list has 20 entries or fewer,
      // so read it alongside the probe: most lists fit on it, and a list that
      // fits on one page is read in one request and needs no check.
      const page1 = fetchPage(1);
      page1.then(
        (page) => onPrefix?.(page),
        () => {},
      );
      let probe: GitHubListPage<StoredItem>;
      try {
        probe = await reprobe();
      } catch (error) {
        page1.catch(() => {});
        throw error;
      }
      onPrefix?.(probe);
      return await verifiedCrawl(probe, fetchPage, reprobe, startedAt, page1);
    } finally {
      clearTimeout(timer);
    }
  });

  const now = Date.now();
  const unchanged =
    !!stored &&
    stored.truncated === result.truncated &&
    JSON.stringify(stored.items) === JSON.stringify(result.items);
  const entry: StoredVersions = {
    head_at: now,
    // An incomplete crawl leaves the full crawl due.
    full_at: result.full ? now : (stored?.full_at ?? 0),
    unchanged_since:
      unchanged && stored ? Math.min(stored.unchanged_since, now) : now,
    generation,
    items: result.items,
    truncated: result.truncated,
  };
  const changed = !unchanged;
  const next: ListMeta = {
    ...(meta ?? { b: true, a: now, r: now }),
    c: changed || !meta ? now : meta.c,
    h: entry.head_at,
    f: entry.full_at,
    u: entry.unchanged_since,
    g: generation,
    e: result.etag ?? undefined,
  };
  await putEntry(env, cacheKey, entry, next);
  return { entry, meta: next, changed };
}

async function putEntry(
  env: Env,
  cacheKey: string,
  entry: StoredVersions,
  meta: ListMeta,
): Promise<void> {
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: CACHE_TTL_SECONDS,
      metadata: meta,
    });
  } catch (error) {
    // The answer stands; the next request reads GitHub again.
    console.warn(`failed to cache GitHub versions ${cacheKey}:`, error);
  }
}

function demandKey(cacheKey: string): string {
  return DEMAND_PREFIX + cacheKey.slice(VERSIONS_CACHE_PREFIX.length);
}

/** When a client last asked for the list at `cacheKey` (epoch ms). */
async function readDemand(
  env: Env,
  cacheKey: string,
): Promise<number | undefined> {
  const demand = await env.GITHUB_CACHE.get<{ requested_at?: unknown }>(
    demandKey(cacheKey),
    "json",
  );
  return typeof demand?.requested_at === "number"
    ? demand.requested_at
    : undefined;
}

/** Record a request for the list at `cacheKey`; true if it was written. */
async function stampDemand(
  env: Env,
  cacheKey: string,
  at: number,
): Promise<boolean> {
  try {
    const last = await readDemand(env, cacheKey);
    if (last !== undefined && at - last < DEMAND_RESOLUTION_MS) return false;
    await env.GITHUB_CACHE.put(
      demandKey(cacheKey),
      JSON.stringify({ requested_at: at }),
      // In metadata too, so the refresher reads all demand with list().
      { expirationTtl: DEMAND_TTL_SECONDS, metadata: { r: at } },
    );
    return true;
  } catch (error) {
    console.warn(`failed to record demand for ${cacheKey}:`, error);
    return false;
  }
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
 * A crawl whose pages are known to join up. Pages are read at slightly
 * different moments, so a release published (or deleted) above a page
 * boundary mid-crawl shifts the list between two reads and can drop an
 * entry. The probe is read again afterwards: if the newest entries or the
 * number of entries changed, the crawl runs once more, and if the list is
 * still moving only the new probe is kept, truncated, with the full crawl
 * left due. If the probe cannot be read again (the deadline passed, or GitHub
 * failed), the pages read are kept as a truncated prefix, also with the full
 * crawl left due.
 */
async function verifiedCrawl(
  probe: GitHubListPage<StoredItem>,
  fetchPage: (page: number) => Promise<GitHubListPage<StoredItem>>,
  reprobe: () => Promise<GitHubListPage<StoredItem>>,
  startedAt: number,
  page1?: Promise<GitHubListPage<StoredItem>>,
): Promise<{
  items: StoredItem[];
  truncated: boolean;
  full: boolean;
  /** The ETag of the last probe that matched the stored list. */
  etag?: string | null;
}> {
  let current = probe;
  let probedAt = startedAt;
  for (let attempt = 0; ; attempt++) {
    if (!current.hasNextPage) {
      page1?.catch(() => {});
      return {
        items: current.items,
        truncated: false,
        full: true,
        etag: current.etag,
      };
    }
    const crawled = await crawl(
      current,
      fetchPage,
      probedAt,
      attempt === 0 ? page1 : undefined,
    );
    // One page is one read: nothing can have shifted between pages.
    if (crawled.pages === 1 && !crawled.truncated) {
      return {
        items: crawled.items,
        truncated: false,
        full: true,
        etag: current.etag,
      };
    }
    const verify = await reprobe().catch(() => null);
    if (verify && sameProbe(verify, current)) {
      return { ...crawled, full: true, etag: verify.etag };
    }
    if (
      verify &&
      attempt === 0 &&
      Date.now() - startedAt < crawlTiming.budgetMs
    ) {
      current = verify;
      probedAt = Date.now();
      continue;
    }
    // The check could not run (out of time, or GitHub failed): keep what was
    // read as a truncated prefix rather than discard it.
    if (!verify) return { ...crawled, truncated: true, full: false };
    return { items: verify.items, truncated: verify.hasNextPage, full: false };
  }
}

/** The same newest entries, and the same number of pages of them. */
function sameProbe(
  a: GitHubListPage<StoredItem>,
  b: GitHubListPage<StoredItem>,
): boolean {
  return (
    a.hasNextPage === b.hasNextPage &&
    a.lastPage === b.lastPage &&
    a.items.length === b.items.length &&
    a.items.every((item, i) => itemKey(item) === itemKey(b.items[i]))
  );
}

/**
 * Every page of 100 up to VERSIONS_MAX_PAGES, in GitHub's order, or as many
 * as fit in crawlTiming.budgetMs. `probe` is the newest PROBE_PER_PAGE
 * entries, read at `probedAt`; its last-page link says how many pages there
 * are and its size how big they are.
 */
async function crawl(
  probe: GitHubListPage<StoredItem>,
  fetchPage: (page: number) => Promise<GitHubListPage<StoredItem>>,
  probedAt = Date.now(),
  /** Page 1, if it is already being read. */
  page1?: Promise<GitHubListPage<StoredItem>>,
): Promise<{ items: StoredItem[]; truncated: boolean; pages: number }> {
  const pages: GitHubListPage<StoredItem>[] = [];
  const known = Math.max(
    1,
    Math.min(
      VERSIONS_MAX_PAGES,
      Math.ceil(((probe.lastPage ?? 1) * PROBE_PER_PAGE) / PER_PAGE),
    ),
  );
  const pageBytes = (probe.bytes || 0) * (PER_PAGE / PROBE_PER_PAGE);
  const concurrency = Math.max(
    1,
    Math.min(
      MAX_PAGE_CONCURRENCY,
      Math.floor(PARSE_BUDGET_BYTES / Math.max(1, pageBytes)),
    ),
  );
  // Start another batch only if it should finish in time, judging by how
  // long the last one took.
  let lastBatchMs = 0;
  const inBudget = () =>
    Date.now() - probedAt + lastBatchMs <= crawlTiming.budgetMs;
  const timed = async <T>(batch: Promise<T>): Promise<T> => {
    const batchStart = Date.now();
    const result = await batch;
    lastBatchMs = Date.now() - batchStart;
    return result;
  };
  // A later page GitHub cannot serve ends the list there, as a truncated
  // prefix; only answers such as a rate limit or a 404 fail the crawl. Page 1
  // has nothing before it, so its failure fails the crawl.
  let failed = false;
  const tryPage = (page: number) =>
    page === 1
      ? (page1 ?? fetchPage(page))
      : fetchPage(page).catch((error) => {
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
  const all = Array.from({ length: known }, (_, i) => i + 1);
  for (
    let i = 0;
    i < all.length && !failed && (i === 0 || inBudget());
    i += concurrency
  ) {
    add(await timed(Promise.all(all.slice(i, i + concurrency).map(tryPage))));
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
  return {
    items,
    truncated: pages[pages.length - 1].hasNextPage,
    pages: pages.length,
  };
}

async function fetchPageWithRetry(
  owner: string,
  repo: string,
  source: VersionsSource,
  asset: string | undefined,
  page: number,
  token: TokenRecord | null,
  signal: AbortSignal | undefined,
  canRetry: () => boolean = () => true,
  perPage = PER_PAGE,
  ifNoneMatch?: string,
): Promise<GitHubListPage<StoredItem>> {
  const read = () =>
    fetchPage(
      owner,
      repo,
      source,
      asset,
      page,
      token,
      signal,
      perPage,
      ifNoneMatch,
    );
  try {
    return await read();
  } catch (error) {
    // GitHub times out on some pages of releases with many assets
    // (openai/codex) and answers the same request on a retry.
    if (!transientError(error) || !canRetry()) throw error;
    return read();
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
  signal?: AbortSignal,
  perPage = PER_PAGE,
  ifNoneMatch?: string,
): Promise<GitHubListPage<StoredItem>> {
  if (source === "tags") {
    const result = await fetchGitHubTagPage(
      owner,
      repo,
      page,
      true,
      token,
      signal,
      perPage,
      ifNoneMatch,
    );
    return { ...result, items: result.items.map(compactTag) };
  }
  const result = await fetchGitHubReleasePage(
    owner,
    repo,
    page,
    token,
    signal,
    perPage,
    ifNoneMatch,
  );
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

const KV_LIST_LIMIT = 1000;
const KV_BULK_GET_LIMIT = 100;

/** Every key under `prefix`, with its metadata: one operation per 1,000. */
async function listAll(
  kv: KVNamespace,
  prefix: string,
): Promise<{ keys: { name: string; metadata?: unknown }[]; ops: number }> {
  const keys: { name: string; metadata?: unknown }[] = [];
  let cursor: string | undefined;
  let ops = 0;
  do {
    const page = await kv.list({ prefix, cursor, limit: KV_LIST_LIMIT });
    ops++;
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { keys, ops };
}

/** JSON values of `keys`: one operation per 100. */
async function getAll<T>(
  kv: KVNamespace,
  keys: string[],
): Promise<Map<string, T | null>> {
  const values = new Map<string, T | null>();
  for (let i = 0; i < keys.length; i += KV_BULK_GET_LIMIT) {
    const chunk = await kv.get<T>(keys.slice(i, i + KV_BULK_GET_LIMIT), "json");
    for (const [key, value] of chunk) values.set(key, value);
  }
  return values;
}

export interface BakedFile {
  /** Relative to /data/. */
  path: string;
  /** When a client last asked for this list, epoch ms, for the file cap. */
  requested_at: number;
  body: string;
}

export interface VersionsChanges {
  /** Lists to write: bakeable, and changed since `since`. */
  files: BakedFile[];
  /** Paths (relative to /data/) to remove: no longer bakeable. */
  deleted: string[];
  /** Pass back for the next page; null when the listing is done. */
  cursor: string | null;
  /** The Worker's clock when this page was read, epoch ms. */
  now: number;
}

/**
 * One page of the lists whose content or bake status changed after `since`
 * (every bakeable list when `since` is absent), for the deploy-time bake.
 * Reads only KV: the refresher has already refreshed the lists and checked
 * their repos, so a deploy makes no GitHub requests. A list the refresher
 * has not seen yet has no metadata and is left to it.
 */
export async function listVersionsChanges(
  env: Env,
  {
    since,
    cursor,
    limit = 200,
  }: { since?: number; cursor?: string; limit?: number },
): Promise<VersionsChanges> {
  const now = Date.now();
  const page = await env.GITHUB_CACHE.list({
    prefix: VERSIONS_CACHE_PREFIX,
    cursor,
    limit: Math.max(1, Math.min(KV_LIST_LIMIT, limit)),
  });
  const changes: VersionsChanges = {
    files: [],
    deleted: [],
    cursor: page.list_complete ? null : page.cursor,
    now,
  };
  const wanted: { key: string; target: VersionsTarget; meta: ListMeta }[] = [];
  for (const key of page.keys) {
    const target = parseVersionsCacheKey(key.name);
    const meta = parseMeta(key.metadata);
    if (!target || !meta) continue;
    if (since !== undefined && meta.c <= since) continue;
    if (meta.b) wanted.push({ key: key.name, target, meta });
    else if (since !== undefined) changes.deleted.push(versionsPath(target));
  }
  const values = await getAll<StoredVersions>(
    env.GITHUB_CACHE,
    wanted.map(({ key }) => key),
  );
  for (const { key, target, meta } of wanted) {
    const stored = values.get(key);
    if (!stored || !Array.isArray(stored.items)) continue;
    changes.files.push({
      path: versionsPath(target),
      requested_at: meta.r ?? meta.c,
      body: JSON.stringify(versionsBody(stored, target)),
    });
  }
  return changes;
}

// The refresher: a Worker cron (every 10 minutes) that keeps the stored lists
// fresh and decides which are baked, so deploys only copy what changed.
export const VERSIONS_REFRESH_CRON = "*/10 * * * *";
// Per run. A run stops starting work after `budgetMs`, and handles at most
// `maxTasks` lists: each costs about four KV operations (read, write,
// visibility, generation) of the 1,000 a Worker invocation may make.
const refreshTiming = { budgetMs: 3 * 60 * 1000, maxTasks: 150 };
const REFRESH_CONCURRENCY = 4;
// A repo's access is checked again this often (the visibility cache's own
// lifetime), so a repo that turns private stops being baked within about an
// hour and one deploy.
const ACCESS_CHECK_MS = 60 * 60 * 1000;
const STATE_PREFIX = "github:versions-state:";
// A run that finds another run's lease still current does nothing, so
// overlapping cron runs (or a run that outlives its interval) don't double
// the work. Runs are idempotent, so a lost lease costs only duplicate work.
const LEASE_KEY = `${STATE_PREFIX}refresher-lease`;
// The watermark of the last bake that was deployed (see recordVersionsBaked).
const BAKED_KEY = `${STATE_PREFIX}baked`;
// When the refresher last dispatched a deploy.
const DISPATCHED_KEY = `${STATE_PREFIX}dispatched`;
// A dispatched deploy not acknowledged after this long is taken to have
// failed, and changes dispatch another.
const DISPATCH_PENDING_MS = 30 * 60 * 1000;

interface RefreshEnv extends BakeEnv {}

export interface RefreshRun {
  skipped?: "leased";
  lists: number;
  refreshed: number;
  /** Lists that stopped being bakeable (unrequested, or their repo). */
  dropped: number;
  /** Lists that became bakeable. */
  added: number;
  failed: number;
  /** Due, but out of time, tasks or tokens this run. */
  deferred: number;
  /** Lists whose content or bake status changed this run. */
  changed: number;
  dispatched: boolean;
}

interface RefreshTask {
  key: string;
  target: VersionsTarget;
  meta: ListMeta | null;
  requestedAt?: number;
  requested: boolean;
  accessDue: boolean;
  step: "fresh" | "head" | "full";
  generation?: string;
  /** How overdue the task is, for ordering. */
  overdue: number;
}

/**
 * One refresher run: refresh due lists, re-check access at its own cadence,
 * stop baking lists nobody asked for in 30 days, mark every change, and
 * dispatch a deploy when changes are waiting for one.
 */
export async function refreshVersionLists(
  env: RefreshEnv,
  { dispatch }: { dispatch?: () => Promise<unknown> } = {},
): Promise<RefreshRun> {
  const kv = env.GITHUB_CACHE;
  const startedAt = Date.now();
  const run: RefreshRun = {
    lists: 0,
    refreshed: 0,
    dropped: 0,
    added: 0,
    failed: 0,
    deferred: 0,
    changed: 0,
    dispatched: false,
  };
  const lease = await kv.get<{ until?: number }>(LEASE_KEY, "json");
  if (typeof lease?.until === "number" && lease.until > startedAt) {
    return { ...run, skipped: "leased" };
  }
  const leaseMs = refreshTiming.budgetMs + 60 * 1000;
  await kv.put(LEASE_KEY, JSON.stringify({ until: startedAt + leaseMs }), {
    expirationTtl: Math.max(60, Math.ceil(leaseMs / 1000)),
  });

  const lists = await listAll(kv, VERSIONS_CACHE_PREFIX);
  const demands = await listAll(kv, DEMAND_PREFIX);
  // Demand stamped before it carried metadata is read from its value.
  const demand = new Map<string, number>();
  const legacy: string[] = [];
  for (const key of demands.keys) {
    const r = (key.metadata as { r?: unknown } | undefined)?.r;
    if (typeof r === "number") demand.set(key.name, r);
    else legacy.push(key.name);
  }
  for (const [key, value] of await getAll<{ requested_at?: unknown }>(
    kv,
    legacy,
  )) {
    if (typeof value?.requested_at === "number") {
      demand.set(key, value.requested_at);
    }
  }

  const tasks: RefreshTask[] = [];
  const releaseRepos: string[] = [];
  let latestChange = 0;
  for (const key of lists.keys) {
    const target = parseVersionsCacheKey(key.name);
    if (!target) continue;
    run.lists++;
    const meta = parseMeta(key.metadata);
    if (meta) latestChange = Math.max(latestChange, meta.c);
    const requestedAt = demand.get(demandKey(key.name));
    const requested =
      requestedAt !== undefined && startedAt - requestedAt < DEMAND_WINDOW_MS;
    const accessDue = !meta || startedAt - meta.a >= ACCESS_CHECK_MS;
    if (!requested && !meta?.b) continue;
    if (target.source === "releases") {
      releaseRepos.push(`${target.owner}/${target.repo}`);
    }
    tasks.push({
      key: key.name,
      target,
      meta,
      requestedAt,
      requested,
      accessDue,
      step: "fresh",
      overdue: 0,
    });
  }
  const generations = await readGitHubLatestReleaseGenerations(
    kv,
    releaseRepos,
  );
  for (const task of tasks) {
    const { target, meta } = task;
    task.generation =
      target.source === "releases"
        ? generations.get(`${target.owner}/${target.repo}`.toLowerCase())
        : undefined;
    task.step = meta
      ? refreshStep(
          freshnessOf(meta),
          startedAt,
          target.source,
          task.generation,
        )
      : "full";
    task.overdue = !task.requested
      ? Number.MAX_SAFE_INTEGER // dropping a list is cheap and changes a bake
      : !meta
        ? Number.MAX_SAFE_INTEGER - 1
        : task.step !== "fresh" || task.accessDue
          ? startedAt - Math.min(meta.h, meta.a)
          : -1;
  }
  const due = tasks
    .filter((task) => task.overdue >= 0)
    .sort((a, b) => b.overdue - a.overdue);
  const accessEnv = { ...env, GITHUB_VISIBILITY_LIMITER: undefined };
  let outOfTokens = false;

  const work = async (task: RefreshTask) => {
    const { key, target } = task;
    const { owner, repo, source, asset } = target;
    const { value: stored, metadata } =
      await kv.getWithMetadata<StoredVersions>(key, "json");
    if (!stored || !Array.isArray(stored.items)) return;
    const now = Date.now();
    // An entry written before lists carried metadata starts unbaked.
    const read = parseMeta(metadata);
    let meta: ListMeta = read ?? {
      c: now,
      b: false,
      a: 0,
      h: stored.head_at,
      f: stored.full_at,
      u: stored.unchanged_since,
      g: stored.generation,
    };
    let bakeable = meta.b;
    if (!task.requested) {
      bakeable = false;
    } else if (task.accessDue || !read) {
      const denied = await checkGitHubMirrorAccess(accessEnv, owner, repo);
      // A failed lookup (429, 503) is no answer: keep the last one.
      if (!denied || denied.status === 403 || denied.status === 404) {
        bakeable = !denied;
        meta = { ...meta, a: now };
      }
    }
    const statusChanged = bakeable !== (read?.b ?? false);
    meta = {
      ...meta,
      b: bakeable,
      r: task.requestedAt ?? meta.r,
      c: statusChanged ? now : meta.c,
    };
    let changed = statusChanged;
    let written = false;
    if (bakeable && task.step !== "fresh") {
      if (outOfTokens) {
        run.deferred++;
      } else {
        try {
          // Writes the entry with `meta`, moving `c` on if the content
          // changed.
          const refreshed = await refreshVersions(
            env,
            owner,
            repo,
            key,
            { source, asset, generation: task.generation },
            stored,
            task.step,
            { requireToken: true, meta },
          );
          meta = refreshed.meta;
          changed ||= refreshed.changed;
          written = true;
          run.refreshed++;
        } catch (error) {
          if (error instanceof NoPoolToken) {
            outOfTokens = true;
            run.deferred++;
          } else {
            run.failed++;
            console.warn(`refresh failed for ${key}:`, error);
          }
        }
      }
    }
    if (statusChanged) {
      if (bakeable) run.added++;
      else run.dropped++;
    }
    if (changed) run.changed++;
    latestChange = Math.max(latestChange, meta.c);
    if (!written && JSON.stringify(read) !== JSON.stringify(meta)) {
      await putEntry(env, key, stored, meta);
    }
  };

  const selected = due.slice(0, refreshTiming.maxTasks);
  run.deferred += due.length - selected.length;
  for (let i = 0; i < selected.length; i += REFRESH_CONCURRENCY) {
    if (Date.now() - startedAt >= refreshTiming.budgetMs) {
      run.deferred += selected.length - i;
      break;
    }
    await Promise.all(
      selected.slice(i, i + REFRESH_CONCURRENCY).map((task) =>
        work(task).catch((error) => {
          run.failed++;
          console.warn(`refresher task failed for ${task.key}:`, error);
        }),
      ),
    );
  }

  // Dispatch a deploy when a change is waiting for one, unless a dispatch
  // is still in flight. A deploy acknowledges what it baked (BAKED_KEY), so
  // changes a catalog deploy already baked dispatch nothing.
  const baked = (await kv.get<{ at?: number }>(BAKED_KEY, "json"))?.at ?? 0;
  const dispatchedAt =
    (await kv.get<{ at?: number }>(DISPATCHED_KEY, "json"))?.at ?? 0;
  const inFlight =
    dispatchedAt > baked && Date.now() - dispatchedAt < DISPATCH_PENDING_MS;
  if (dispatch && latestChange > baked && !inFlight) {
    try {
      await dispatch();
      await kv.put(DISPATCHED_KEY, JSON.stringify({ at: Date.now() }));
      run.dispatched = true;
    } catch (error) {
      // Not recorded, so the next run tries again.
      console.warn("deploy dispatch for GitHub version lists failed:", error);
    }
  }
  await kv.delete(LEASE_KEY);
  return run;
}

/**
 * A deploy published the lists changed up to `watermark` (the `now` of its
 * first changes page). The refresher dispatches deploys only for changes
 * after the latest such watermark.
 */
export async function recordVersionsBaked(
  env: Env,
  watermark: number,
): Promise<number> {
  const current =
    (await env.GITHUB_CACHE.get<{ at?: number }>(BAKED_KEY, "json"))?.at ?? 0;
  const at = Math.max(current, watermark);
  if (at !== current) {
    await env.GITHUB_CACHE.put(BAKED_KEY, JSON.stringify({ at }));
  }
  return at;
}

const BAKE_CONCURRENCY = 6;

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
  // Paths that name no list; repeats of a valid path are just repeats.
  let unknown = 0;
  const keys = new Set<string>();
  for (const path of paths) {
    const target = parseVersionsPath(path);
    if (target) keys.add(versionsCacheKey(target));
    else unknown++;
  }
  const unique = [...keys];
  for (let i = 0; i < unique.length; i += BAKE_CONCURRENCY) {
    await Promise.all(
      unique.slice(i, i + BAKE_CONCURRENCY).map(async (key) => {
        if (await stampDemand(env, key, seenAt)) stamped++;
      }),
    );
  }
  return { stamped, unknown };
}

export const __testing = {
  crawl,
  /** Lower the refresher's per-run limits for a test. */
  setRefreshTiming(timing: { budgetMs?: number; maxTasks?: number }) {
    Object.assign(refreshTiming, timing);
  },
  /** Shorten the crawl's time limits for a test. */
  setCrawlTiming(timing: {
    budgetMs?: number;
    deadlineMs?: number;
    coldWaitMs?: number;
  }) {
    Object.assign(crawlTiming, timing);
  },
  mergeHead,
  parseVersionsCacheKey,
  refreshStep,
  versionsCacheKey,
};
