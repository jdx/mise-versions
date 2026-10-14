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
// The first batch of pages starts before any page's real size is known, so
// it reads at most this many at once; later batches are sized from the
// largest page seen.
const FIRST_BATCH_MAX = 3;

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
    refreshVersions(env, owner, repo, cacheKey, options, stored, step);
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
    (entry) => ({ entry }) as const,
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
  }: {
    requireToken?: boolean;
    /**
     * Called with each newest-first page as soon as it is read (the probe,
     * then page 1), for an answer that cannot wait for the whole list.
     */
    onPrefix?: (page: GitHubListPage<StoredItem>) => void;
  } = {},
): Promise<StoredVersions> {
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
      const fetchPage = (page: number, perPage = PER_PAGE, dates = true) =>
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
          dates,
        );
      const reprobe = () => fetchPage(1, PROBE_PER_PAGE);
      // One entry per page: its last-page link is the exact entry count.
      const tally = () => {
        const read = fetchPage(1, 1, false);
        read.catch(() => {});
        return read;
      };
      const crawl = { fetchPage, reprobe, tally, startedAt };
      if (stored && step === "head") {
        const probe = await reprobe();
        onPrefix?.(probe);
        // A probe with nothing after it is the whole list: a full crawl.
        if (!probe.hasNextPage) {
          return { items: probe.items, truncated: false, full: true };
        }
        const merged = mergeHead(probe, stored);
        if (merged) return { ...merged, full: false };
        return await verifiedCrawl(probe, crawl, { before: tally() });
      }
      // A full crawl needs page 1 unless the list has 20 entries or fewer,
      // so read it alongside the probe: most lists fit on it, and a list that
      // fits on one page is read in one request and needs no check. The
      // entry count to check the crawl against is read alongside too.
      const page1 = fetchPage(1);
      page1.then(
        (page) => onPrefix?.(page),
        () => {},
      );
      const before = tally();
      const probe = await reprobe();
      onPrefix?.(probe);
      return await verifiedCrawl(probe, crawl, { page1, before });
    } finally {
      clearTimeout(timer);
      // Reads the crawl no longer needs (page 1 when the probe was the whole
      // list, the count when the crawl ended early) are cancelled rather
      // than left running past the deadline.
      deadline.abort(new Error("GitHub crawl finished"));
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
      { expirationTtl: DEMAND_TTL_SECONDS },
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
 * different moments, so a release published or deleted above a page
 * boundary mid-crawl shifts the list between two reads and can drop an
 * entry. The exact number of entries (one entry per page: the last-page
 * link) and the newest entry are read before and after: if either changed,
 * the crawl runs once more, and if the list is still moving only a new probe
 * is kept, truncated, with the full crawl left due. If the count cannot be
 * read (the deadline passed, or GitHub failed), the pages read are kept as a
 * truncated prefix, also with the full crawl left due.
 */
async function verifiedCrawl(
  probe: GitHubListPage<StoredItem>,
  {
    fetchPage,
    reprobe,
    tally,
    startedAt,
  }: {
    fetchPage: (page: number) => Promise<GitHubListPage<StoredItem>>;
    reprobe: () => Promise<GitHubListPage<StoredItem>>;
    tally: () => Promise<GitHubListPage<StoredItem>>;
    startedAt: number;
  },
  {
    page1,
    before,
  }: {
    page1?: Promise<GitHubListPage<StoredItem>>;
    before: Promise<GitHubListPage<StoredItem>>;
  },
): Promise<{ items: StoredItem[]; truncated: boolean; full: boolean }> {
  let current = probe;
  let probedAt = startedAt;
  let start = before;
  for (let attempt = 0; ; attempt++) {
    if (!current.hasNextPage) {
      return { items: current.items, truncated: false, full: true };
    }
    const crawled = await crawl(
      current,
      fetchPage,
      probedAt,
      attempt === 0 ? page1 : undefined,
    );
    // One page is one read: nothing can have shifted between pages.
    if (crawled.pages === 1 && !crawled.truncated) {
      return { items: crawled.items, truncated: false, full: true };
    }
    const [first, last] = await Promise.all([
      start.catch(() => null),
      tally().catch(() => null),
    ]);
    if (!first || !last) {
      // The check could not run (out of time, or GitHub failed): keep what
      // was read as a truncated prefix rather than discard it.
      return { ...crawled, truncated: true, full: false };
    }
    if (sameTally(first, last)) return { ...crawled, full: true };
    if (attempt === 0 && Date.now() - startedAt < crawlTiming.budgetMs) {
      start = Promise.resolve(last);
      probedAt = Date.now();
      current = await reprobe();
      continue;
    }
    const latest = await reprobe().catch(() => current);
    return { items: latest.items, truncated: latest.hasNextPage, full: false };
  }
}

/** The same number of entries, with the same newest one. */
function sameTally(
  a: GitHubListPage<StoredItem>,
  b: GitHubListPage<StoredItem>,
): boolean {
  const count = (page: GitHubListPage<StoredItem>) =>
    page.hasNextPage ? page.lastPage : page.items.length;
  return (
    count(a) !== null &&
    count(a) === count(b) &&
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
  // Concurrency is sized so about PARSE_BUDGET_BYTES of JSON is read at
  // once: from the probe's size at first, then from the largest page seen.
  let largestPage = (probe.bytes || 0) * (PER_PAGE / PROBE_PER_PAGE);
  const concurrency = () =>
    Math.max(
      1,
      Math.min(
        MAX_PAGE_CONCURRENCY,
        Math.floor(PARSE_BUDGET_BYTES / Math.max(1, largestPage)),
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
      largestPage = Math.max(largestPage, result.bytes || 0);
      pages.push(result);
    }
  };
  let next = 1;
  while (next <= known && !failed && (next === 1 || inBudget())) {
    const size =
      next === 1 ? Math.min(FIRST_BATCH_MAX, concurrency()) : concurrency();
    const batch = Array.from(
      { length: Math.min(size, known - next + 1) },
      (_, i) => next + i,
    );
    next += batch.length;
    add(await timed(Promise.all(batch.map(tryPage))));
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
  dates = true,
): Promise<GitHubListPage<StoredItem>> {
  const read = () =>
    fetchPage(owner, repo, source, asset, page, token, signal, perPage, dates);
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
  /** Tags only: read commit dates too (a GraphQL query). */
  dates = true,
): Promise<GitHubListPage<StoredItem>> {
  if (source === "tags") {
    const result = await fetchGitHubTagPage(
      owner,
      repo,
      page,
      dates,
      token,
      signal,
      perPage,
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
    const [stored, requestedAt] = await Promise.all([
      env.GITHUB_CACHE.get<StoredVersions>(key, "json"),
      readDemand(env, key),
    ]);
    if (!stored || !Array.isArray(stored.items)) return;
    const now = Date.now();
    if (!requestedAt || now - requestedAt >= DEMAND_WINDOW_MS) {
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
      requested_at: requestedAt,
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
