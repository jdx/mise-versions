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

// Page 1 is re-read this often, like the release list's first page and an
// untracked `latest`. New releases and tags land there.
const HEAD_FRESH_MS = 10 * 60 * 1000;
// A repo the catalog tracks has a release generation that rotates when a
// release is published, so its head can be re-read less often while the list
// stays the same: a quarter of how long it has been unchanged, up to this.
const TRACKED_MAX_HEAD_FRESH_MS = 6 * 60 * 60 * 1000;
const STABLE_FRESH_FRACTION = 4;
// Everything past page 1 (edits, deletions, a tag on an older line) is
// caught by a full re-crawl this often: the mutable-release window for
// releases, the later-page window of the tag list for tags.
const RELEASES_FULL_FRESH_MS = 6 * 60 * 60 * 1000;
const TAGS_FULL_FRESH_MS = 60 * 60 * 1000;
// Kept well past freshness so a GitHub outage can be bridged.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MIN_EDGE_SECONDS = 60;

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

export type GitHubVersions =
  | { source: "releases"; releases: VersionsRelease[]; truncated: boolean }
  | { source: "tags"; tags: VersionsTag[]; truncated: boolean };

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

export interface VersionsOptions {
  source: VersionsSource;
  /** Releases only: keep only releases carrying an asset of this name. */
  asset?: string;
  /** The repo's current release generation, when the catalog tracks it. */
  generation?: string;
  /** Identifies the caller for the cold-crawl rate limit. */
  clientKey?: string;
}

export interface VersionsResult {
  versions: GitHubVersions;
  /**
   * How long the edge may keep this answer: the rest of its freshness, 60s
   * while it is being refreshed, 0 for a stale fallback.
   */
  edgeSeconds: number;
  staleFallback: boolean;
}

export function validAssetName(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9._+@~-]{1,255}$/.test(value);
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
  const cacheKey = versionsCacheKey(owner, repo, source, asset);
  const stored = await env.GITHUB_CACHE.get<StoredVersions>(cacheKey, "json");
  const step = refreshStep(stored, Date.now(), source, options.generation);
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
): Promise<StoredVersions> {
  const result = await withPoolToken(env, async (token) => {
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
  const entry: StoredVersions = {
    head_at: now,
    full_at: result.full || !stored ? now : stored.full_at,
    unchanged_since:
      unchanged && stored ? Math.min(stored.unchanged_since, now) : now,
    generation,
    items: result.items,
    truncated: result.truncated,
  };
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    // The answer stands; the next request reads GitHub again.
    console.warn(
      `failed to cache GitHub versions for ${owner}/${repo}:`,
      error,
    );
  }
  return entry;
}

function versionsCacheKey(
  owner: string,
  repo: string,
  source: VersionsSource,
  asset?: string,
): string {
  const repository = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return `github:versions:${source}:${repository}${asset ? `:asset:${asset}` : ""}`;
}

function headFreshMs(
  stored: StoredVersions,
  source: VersionsSource,
  generation?: string,
): number {
  if (source !== "releases" || !generation) return HEAD_FRESH_MS;
  const stableMs = stored.head_at - stored.unchanged_since;
  return Math.min(
    TRACKED_MAX_HEAD_FRESH_MS,
    Math.max(HEAD_FRESH_MS, stableMs / STABLE_FRESH_FRACTION),
  );
}

function fullFreshMs(source: VersionsSource): number {
  return source === "releases" ? RELEASES_FULL_FRESH_MS : TAGS_FULL_FRESH_MS;
}

/** When `stored` stops being fresh. */
function freshUntil(
  stored: StoredVersions,
  source: VersionsSource,
  generation?: string,
): number {
  return Math.min(
    stored.head_at + headFreshMs(stored, source, generation),
    stored.full_at + fullFreshMs(source),
  );
}

function refreshStep(
  stored: StoredVersions | null,
  now: number,
  source: VersionsSource,
  generation?: string,
): "fresh" | "head" | "full" {
  if (!stored || !Array.isArray(stored.items)) return "full";
  if (now - stored.full_at >= fullFreshMs(source)) return "full";
  // A new generation means the catalog saw a release published.
  if (stored.generation !== generation) return "head";
  return now < freshUntil(stored, source, generation) ? "fresh" : "head";
}

function respond(
  stored: StoredVersions,
  { source, asset, generation }: VersionsOptions,
  state: "fresh" | "refreshing" | "stale",
): VersionsResult {
  // A list being refreshed is kept at the edge only briefly, so the next
  // request after the refresh reads the new one; a stale fallback not at all.
  const edgeSeconds =
    state === "stale"
      ? 0
      : state === "refreshing"
        ? MIN_EDGE_SECONDS
        : Math.max(
            MIN_EDGE_SECONDS,
            Math.ceil(
              (freshUntil(stored, source, generation) - Date.now()) / 1000,
            ),
          );
  const staleFallback = state === "stale";
  if (source === "tags") {
    return {
      versions: {
        source,
        tags: stored.items as VersionsTag[],
        truncated: stored.truncated,
      },
      edgeSeconds,
      staleFallback,
    };
  }
  let releases = stored.items as StoredRelease[];
  if (asset) {
    releases = releases
      .filter((release) => release.has_asset)
      .map(({ has_asset: _hasAsset, ...release }) => release);
  }
  return {
    versions: { source, releases, truncated: stored.truncated },
    edgeSeconds,
    staleFallback,
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

export const __testing = {
  crawl,
  mergeHead,
  refreshStep,
  versionsCacheKey,
};
