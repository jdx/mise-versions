import { drizzle } from "drizzle-orm/d1";
import { uncompress } from "snappyjs";
import { setupDatabase } from "../../../../src/database";
import { hasBudget } from "../../../../src/token-budget";
import { readThroughMemo, writeMemo } from "./edge-memo";

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const RELEASE_FRESH_MS = 6 * 60 * 60 * 1000;
// Maintainers most often re-upload assets in the first hours or days after
// publishing, so mutable releases in this window refresh much sooner.
const YOUNG_RELEASE_MS = 2 * 24 * 60 * 60 * 1000;
const YOUNG_RELEASE_FRESH_MS = 30 * 60 * 1000;
const EDGE_YOUNG_RELEASE_TTL_SECONDS = 30 * 60;
const BROWSER_YOUNG_RELEASE_MAX_AGE_SECONDS = 10 * 60;
// `latest` for a repo the catalog does not track has no generation to
// invalidate it when a release is published, so it expires on its own.
const UNTRACKED_LATEST_FRESH_MS = 10 * 60 * 1000;
const EDGE_UNTRACKED_LATEST_TTL_SECONDS = 10 * 60;
const EMPTY_RELEASE_FRESH_MS = 30 * 60 * 1000;
const EMPTY_RELEASE_CACHE_TTL_SECONDS = 30 * 60;
const RELEASE_IMMUTABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_RELEASE_NOT_FOUND_FRESH_MS = 30 * 60 * 1000;
const NEGATIVE_RELEASE_AUTH_FRESH_MS = 5 * 60 * 1000;
const NEGATIVE_RELEASE_TRANSIENT_FRESH_MS = 60 * 1000;
export const ATTESTATION_FRESH_SECONDS = 30 * 60;
const ATTESTATION_FRESH_MS = ATTESTATION_FRESH_SECONDS * 1000;
// Attestations for a digest can still be added in the hours after a release
// is published, but almost never later. Once a cached answer has stopped
// changing, check it less often: a quarter of how long it has been stable,
// up to a day. Each check rewrites the KV entry, so this is most of the
// mirror's KV writes for long-lived digests. A late attestation (see #289)
// can be missing from the mirror for up to that long; mise >= 2026.8.15
// retries GitHub directly when the mirror's set fails verification
// (mise#12495).
const ATTESTATION_STABLE_FRESH_FRACTION = 4;
const ATTESTATION_MAX_FRESH_MS = 24 * 60 * 60 * 1000;
const EDGE_SHORT_TTL_SECONDS = 60 * 60;
const EDGE_IMMUTABLE_TTL_SECONDS = 365 * 24 * 60 * 60;
const EDGE_MIRROR_CACHE_TTL_SECONDS = 60 * 60;

interface CacheEntry<T> {
  cached_at: number;
  data: T;
  /**
   * When the cached data last changed, for entries whose refresh window
   * grows while they stay the same (see getOrRefresh's `fingerprint`).
   */
  unchanged_since?: number;
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  url: string;
  digest?: string | null;
  updated_at?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at?: string | null;
  updated_at?: string | null;
  immutable?: boolean;
  assets: GitHubAsset[];
}

export interface GitHubListedAsset extends GitHubAsset {
  updated_at?: string | null;
}

export interface GitHubListedRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string | null;
  assets: GitHubListedAsset[];
}

export interface GitHubReleaseListPage {
  releases: GitHubListedRelease[];
  /**
   * The page to request next, or null when there is none to request here.
   * Computed before drafts are removed, so a short `releases` array does not
   * mean the end.
   */
  next_page: number | null;
  /**
   * The repository has more releases than the mirror serves
   * (RELEASE_LIST_MAX_PAGE pages); the rest must come from GitHub.
   */
  truncated: boolean;
}

/** A tag as GitHub's REST tag list returns it, trimmed to what mise reads. */
export interface GitHubTag {
  name: string;
  commit: { sha: string; url: string };
  /**
   * The tagged commit's committer date. Present only when dates were
   * requested; null when GitHub has no commit for the tag.
   */
  date?: string | null;
}

export interface GitHubTagListPage {
  tags: GitHubTag[];
  /** The page to request next, or null when there is none to request here. */
  next_page: number | null;
  /**
   * The repository has more tags than the mirror serves (TAG_LIST_MAX_PAGE
   * pages); the rest must come from GitHub.
   */
  truncated: boolean;
}

interface GitHubAttestation {
  bundle?: unknown;
  bundle_url?: string;
}

interface CachedGitHubError {
  status: number;
  message: string;
}

export interface GitHubAttestationsResponse {
  attestations: GitHubAttestation[];
}

interface Env {
  DB: D1Database;
  GITHUB_CACHE: KVNamespace;
}

export interface TokenRecord {
  id: number;
  token: string;
  // Filled in from GitHub's rate-limit headers as the token is used.
  remaining?: number;
  rateLimitReset?: string;
}

export function cacheHeaders({
  browserMaxAge = 600,
  edgeMaxAge = EDGE_SHORT_TTL_SECONDS,
  immutable = false,
  staleWhileRevalidate = 24 * 60 * 60,
}: {
  browserMaxAge?: number;
  edgeMaxAge?: number;
  immutable?: boolean;
  staleWhileRevalidate?: number;
} = {}): Record<string, string> {
  const directives = [
    `public`,
    `max-age=${browserMaxAge}`,
    `s-maxage=${edgeMaxAge}`,
  ];
  if (immutable) {
    directives.push("immutable");
  } else if (staleWhileRevalidate > 0) {
    directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }
  return {
    "Cache-Control": directives.join(", "),
  };
}

export function releaseCacheHeaders(
  tag: string,
  release: GitHubRelease,
  cacheGeneration?: string,
) {
  if (isUntrackedLatest(tag, cacheGeneration)) {
    return cacheHeaders({
      browserMaxAge: 0,
      edgeMaxAge: EDGE_UNTRACKED_LATEST_TTL_SECONDS,
      staleWhileRevalidate: 0,
    });
  }
  const immutable = tag !== "latest" && release.immutable === true;
  if (!immutable && isYoungRelease(release)) {
    return cacheHeaders({
      browserMaxAge:
        tag === "latest" ? 0 : BROWSER_YOUNG_RELEASE_MAX_AGE_SECONDS,
      edgeMaxAge: EDGE_YOUNG_RELEASE_TTL_SECONDS,
      staleWhileRevalidate: 0,
    });
  }
  return cacheHeaders({
    browserMaxAge:
      tag === "latest" ? 0 : immutable ? 600 : EDGE_SHORT_TTL_SECONDS,
    edgeMaxAge: immutable ? EDGE_IMMUTABLE_TTL_SECONDS : EDGE_SHORT_TTL_SECONDS,
    staleWhileRevalidate: tag === "latest" ? 0 : undefined,
    immutable,
  });
}

export function releaseEdgeCacheOptions(
  tag: string,
  release: GitHubRelease,
  cacheGeneration?: string,
): EdgeCacheOptions {
  const young = release.immutable !== true && isYoungRelease(release);
  return {
    browserMaxAge: tag === "latest" ? 0 : undefined,
    edgeMaxAge: isUntrackedLatest(tag, cacheGeneration)
      ? EDGE_UNTRACKED_LATEST_TTL_SECONDS
      : young
        ? EDGE_YOUNG_RELEASE_TTL_SECONDS
        : undefined,
    staleWhileRevalidate: tag === "latest" || young ? 0 : undefined,
    cacheGeneration,
  };
}

function isUntrackedLatest(tag: string, cacheGeneration?: string): boolean {
  return tag === "latest" && !cacheGeneration;
}

function isYoungRelease(release: GitHubRelease): boolean {
  const timestamp = new Date(release.published_at ?? "").getTime();
  return (
    Number.isFinite(timestamp) && Date.now() - timestamp < YOUNG_RELEASE_MS
  );
}

function releaseFreshMs(release: GitHubRelease): number {
  if (release.assets.length === 0) {
    return EMPTY_RELEASE_FRESH_MS;
  }
  return isYoungRelease(release) ? YOUNG_RELEASE_FRESH_MS : RELEASE_FRESH_MS;
}

export function attestationsCacheHeaders() {
  return cacheHeaders({
    browserMaxAge: ATTESTATION_FRESH_SECONDS,
    edgeMaxAge: ATTESTATION_FRESH_SECONDS,
    staleWhileRevalidate: 0,
  });
}

// The zone's Browser Cache TTL (2 hours) replaces a lower `max-age` on
// responses served from the Cache API, so an edge hit would tell browsers
// and proxies to keep for 2 hours what the Worker answered with max-age=0.
// The Cache-Control the Worker meant is kept in this header and put back.
const EDGE_CACHE_CONTROL_HEADER = "X-Mise-Cache-Control";

export async function matchGitHubMirrorEdgeCache(
  request: Request,
  cacheGeneration?: string,
  cacheKeyParams?: Record<string, string>,
): Promise<Response | null> {
  try {
    const cached = await defaultEdgeCache().match(
      edgeCacheRequest(request, cacheGeneration, cacheKeyParams),
    );
    return cached ? withIntendedCacheControl(cached) : null;
  } catch (error) {
    console.warn("failed to read GitHub mirror edge cache:", error);
    return null;
  }
}

export async function putGitHubMirrorEdgeCache(
  request: Request,
  response: Response,
  options?: EdgeCacheOptions,
): Promise<void> {
  if (response.status !== 200) return;

  try {
    await defaultEdgeCache().put(
      edgeCacheRequest(
        request,
        options?.cacheGeneration,
        options?.cacheKeyParams,
      ),
      edgeCacheResponse(response, options),
    );
  } catch (error) {
    console.warn("failed to write GitHub mirror edge cache:", error);
  }
}

export interface EdgeCacheOptions {
  browserMaxAge?: number;
  edgeMaxAge?: number;
  staleWhileRevalidate?: number;
  cacheGeneration?: string;
  cacheKeyParams?: Record<string, string>;
}

function withIntendedCacheControl(response: Response): Response {
  const intended = response.headers.get(EDGE_CACHE_CONTROL_HEADER);
  if (!intended) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", intended);
  headers.delete(EDGE_CACHE_CONTROL_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function edgeCacheResponse(
  response: Response,
  {
    browserMaxAge = 600,
    edgeMaxAge = EDGE_MIRROR_CACHE_TTL_SECONDS,
    staleWhileRevalidate = 24 * 60 * 60,
  }: EdgeCacheOptions = {},
): Response {
  const headers = new Headers(response.headers);
  const directives = [
    "public",
    `max-age=${browserMaxAge}`,
    `s-maxage=${edgeMaxAge}`,
  ];
  if (staleWhileRevalidate > 0) {
    directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }
  headers.set("Cache-Control", directives.join(", "));
  headers.set(EDGE_CACHE_CONTROL_HEADER, directives.join(", "));
  return new Response(response.clone().body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function defaultEdgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

function edgeCacheRequest(
  request: Request,
  cacheGeneration?: string,
  cacheKeyParams?: Record<string, string>,
): Request {
  // Query params are ignored by these mirror handlers, so strip them to avoid
  // unbounded cache-key variants; handlers that read a param pass its
  // normalized value back in `cacheKeyParams`. Cache API cold misses are not
  // coalesced. Routes check repo visibility before reading this cache, so a
  // repo that turns private stops being served once that check expires.
  const url = new URL(request.url);
  url.search = "";
  for (const [key, value] of Object.entries(cacheKeyParams ?? {})) {
    url.searchParams.set(key, value);
  }
  if (cacheGeneration) {
    url.searchParams.set("__mise_cache_generation", cacheGeneration);
  }
  return new Request(url.toString(), { method: "GET" });
}

export function validRepoPart(value: string | undefined): value is string {
  return (
    !!value &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(value)
  );
}

export function validReleaseTag(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_.\/:@+-]+$/.test(value);
}

export function validDigest(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_.-]+:[A-Fa-f0-9]+$/.test(value);
}

/** GitHub (REST or GraphQL) rate-limited the pool token. */
export function isGitHubRateLimited(error: unknown): boolean {
  return isRateLimited(error);
}

export function githubStatus(error: unknown): number | null {
  return error instanceof GitHubError ? error.status : null;
}

export async function getCachedGitHubRelease(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
  cacheGeneration?: string,
  previousCacheGeneration?: string,
): Promise<GitHubRelease> {
  return (
    await getCachedGitHubReleaseResult(
      env,
      owner,
      repo,
      tag,
      cacheGeneration,
      previousCacheGeneration,
    )
  ).release;
}

export async function getCachedGitHubReleaseResult(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
  cacheGeneration?: string,
  previousCacheGeneration?: string,
): Promise<{ release: GitHubRelease; staleFallback: boolean }> {
  const cacheRepository = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const generationSuffix = cacheGeneration ? `:${cacheGeneration}` : "";
  const cacheKey = `github:release:${cacheRepository}:${tag}${generationSuffix}`;
  const negativeCacheKey = `github:release-error:${cacheRepository}:${tag}${generationSuffix}`;

  let release: GitHubRelease;
  let staleFallback = false;
  try {
    release = await getOrRefresh({
      env,
      cacheKey,
      isFresh: (entry) =>
        (tag !== "latest" && entry.data.immutable === true) ||
        Date.now() - entry.cached_at <
          (isUntrackedLatest(tag, cacheGeneration)
            ? Math.min(UNTRACKED_LATEST_FRESH_MS, releaseFreshMs(entry.data))
            : releaseFreshMs(entry.data)),
      // Only consulted when there is no fresh positive entry: a fresh entry
      // and a fresh error cannot both have come from the same refresh, and
      // skipping this read saves a KV read on every positive edge-cache miss.
      beforeFetch: async () => {
        const cachedError = await cachedReleaseError(env, negativeCacheKey);
        if (cachedError) throw cachedError;
      },
      fetcher: (token) => fetchGitHubRelease(owner, repo, tag, token),
      expirationTtl: (data) =>
        data.assets.length === 0
          ? EMPTY_RELEASE_CACHE_TTL_SECONDS
          : tag !== "latest" && data.immutable === true
            ? undefined
            : CACHE_TTL_SECONDS,
      useStaleOnError: releaseStaleFallbackAllowed,
      onStaleFallback: () => {
        staleFallback = true;
      },
      staleCacheKey:
        tag === "latest" && cacheGeneration
          ? `github:release:${cacheRepository}:${tag}${previousCacheGeneration ? `:${previousCacheGeneration}` : ""}`
          : undefined,
      onFetchError: async (error, cached) => {
        if (cached && githubStatus(error) === 404) {
          await deleteCachedRelease(env, cacheKey);
        }
      },
    });
  } catch (error) {
    // A cached error is already stored; rewriting it would extend it.
    if (error instanceof CachedReleaseError) throw error;
    try {
      await cacheReleaseError(env, negativeCacheKey, error);
    } catch (cacheError) {
      console.warn(
        "failed to persist GitHub release negative cache:",
        cacheError,
      );
    }
    throw error;
  }
  if (release.assets.length === 0) {
    throw new GitHubError(
      404,
      "GitHub release response did not include assets",
      new Headers(),
    );
  }
  return { release, staleFallback };
}

async function cachedReleaseError(
  env: Env,
  cacheKey: string,
): Promise<GitHubError | null> {
  // A stored error is never rewritten while it is fresh (requests are
  // refused until it expires), so it can be memoized at the edge until then.
  // Its absence cannot: a failed refresh may store one at any time.
  const cached = await readThroughMemo<CachedGitHubError | null>(
    env.GITHUB_CACHE,
    cacheKey,
    async () => {
      const entry = await env.GITHUB_CACHE.get<CacheEntry<CachedGitHubError>>(
        cacheKey,
        "json",
      );
      const freshMs = entry ? releaseErrorFreshMs(entry.data.status) : null;
      const now = Date.now();
      if (!entry || !freshMs || now - entry.cached_at >= freshMs) {
        return { value: null, expiresAt: 0 };
      }
      return {
        value: entry.data,
        expiresAt: Math.min(entry.cached_at, now) + freshMs,
      };
    },
  );
  if (!cached) {
    return null;
  }
  return new CachedReleaseError(cached.status, cached.message, new Headers());
}

async function cacheReleaseError(
  env: Env,
  cacheKey: string,
  error: unknown,
): Promise<void> {
  // A draft may be published any minute; don't hide it behind a 404.
  if (!(error instanceof GitHubError) || error instanceof DraftReleaseError) {
    return;
  }
  const freshMs = releaseErrorFreshMs(error.status, error);
  if (!freshMs) {
    return;
  }
  const cachedAt = Date.now();
  const data: CachedGitHubError = {
    status: error.status,
    message: error.message,
  };
  await env.GITHUB_CACHE.put(
    cacheKey,
    JSON.stringify({ cached_at: cachedAt, data }),
    { expirationTtl: Math.ceil(freshMs / 1000) },
  );
  await writeMemo(env.GITHUB_CACHE, cacheKey, data, cachedAt + freshMs);
}

async function deleteCachedRelease(env: Env, cacheKey: string): Promise<void> {
  try {
    await env.GITHUB_CACHE.delete?.(cacheKey);
  } catch (error) {
    console.warn("failed to delete stale GitHub release cache:", error);
  }
}

function releaseErrorFreshMs(status: number, error?: unknown): number | null {
  if (status === 404) {
    return NEGATIVE_RELEASE_NOT_FOUND_FRESH_MS;
  }
  if (error && isRateLimited(error)) {
    return null;
  }
  if (status === 401 || status === 403) {
    return NEGATIVE_RELEASE_AUTH_FRESH_MS;
  }
  if (status >= 500 && status < 600) {
    return NEGATIVE_RELEASE_TRANSIENT_FRESH_MS;
  }
  return null;
}

/**
 * Whether a failed refresh may serve the entry it was refreshing: for rate
 * limits, network errors and 5xx, not for answers such as a 404.
 */
export function releaseStaleFallbackAllowed(error: unknown): boolean {
  const status = githubStatus(error);
  return isRateLimited(error) || status === null || status >= 500;
}

export async function getCachedGitHubAttestations(
  env: Env,
  owner: string,
  repo: string,
  digest: string,
): Promise<GitHubAttestationsResponse> {
  return getOrRefresh({
    env,
    cacheKey: `github:attestations:${owner}/${repo}:${digest}`,
    isFresh: (entry) =>
      Date.now() - entry.cached_at < attestationFreshMs(entry),
    fetcher: (token) => fetchGitHubAttestations(owner, repo, digest, token),
    expirationTtl: () => CACHE_TTL_SECONDS,
    fingerprint: attestationsFingerprint,
  });
}

function attestationFreshMs(
  entry: CacheEntry<GitHubAttestationsResponse>,
): number {
  if (typeof entry.unchanged_since !== "number") return ATTESTATION_FRESH_MS;
  const stableMs = entry.cached_at - entry.unchanged_since;
  return Math.min(
    ATTESTATION_MAX_FRESH_MS,
    Math.max(
      ATTESTATION_FRESH_MS,
      stableMs / ATTESTATION_STABLE_FRESH_FRACTION,
    ),
  );
}

// What makes two attestation answers the same. `bundle_url` is left out: it
// can be a signed blob URL that differs on every fetch, and the bundle it
// points at is already inlined.
function attestationsFingerprint(data: GitHubAttestationsResponse): string {
  return JSON.stringify(
    (data.attestations ?? []).map((attestation) => {
      const rest: Record<string, unknown> = { ...attestation };
      delete rest.bundle_url;
      return rest;
    }),
  );
}

export const RELEASE_LIST_MAX_PAGE = 10;
const RELEASE_LIST_PER_PAGE = 100;
const RELEASE_LIST_FIRST_PAGE_FRESH_MS = 10 * 60 * 1000;
const RELEASE_LIST_PAGE_FRESH_MS = 60 * 60 * 1000;

export function releaseListFreshSeconds(page: number): number {
  return (
    (page === 1
      ? RELEASE_LIST_FIRST_PAGE_FRESH_MS
      : RELEASE_LIST_PAGE_FRESH_MS) / 1000
  );
}

/**
 * One page (100 releases) of a repository's release list, drafts removed.
 * Only call this for a repo that passed the visibility check.
 */
export async function getCachedGitHubReleaseList(
  env: Env,
  owner: string,
  repo: string,
  page: number,
  cacheGeneration?: string,
): Promise<{ list: GitHubReleaseListPage; staleFallback: boolean }> {
  if (!Number.isInteger(page) || page < 1 || page > RELEASE_LIST_MAX_PAGE) {
    throw new GitHubError(400, "Invalid page", new Headers());
  }
  const cacheRepository = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const generationSuffix = cacheGeneration ? `:${cacheGeneration}` : "";
  const freshMs = releaseListFreshSeconds(page) * 1000;
  let staleFallback = false;
  const list = await getOrRefresh<GitHubReleaseListPage>({
    env,
    cacheKey: `github:releases:${cacheRepository}:${page}${generationSuffix}`,
    isFresh: (entry) => Date.now() - entry.cached_at < freshMs,
    fetcher: (token) => fetchGitHubReleaseList(owner, repo, page, token),
    expirationTtl: () => CACHE_TTL_SECONDS,
    useStaleOnError: releaseStaleFallbackAllowed,
    onStaleFallback: () => {
      staleFallback = true;
    },
  });
  return { list, staleFallback };
}

export const TAG_LIST_MAX_PAGE = RELEASE_LIST_MAX_PAGE;
const TAG_LIST_PER_PAGE = 100;
const TAG_LIST_FIRST_PAGE_FRESH_MS = 10 * 60 * 1000;
const TAG_LIST_PAGE_FRESH_MS = 60 * 60 * 1000;

// GitHub lists tags by name, highest version first, not by date. The newest
// version of the newest line is on page 1, which is all most mise lookups
// read, so page 1 refreshes like the release list's. A tag pushed on an older
// line can land on a later page and shift the rest by one; full listings
// accept that for up to an hour, as they do for releases. No catalog
// generation invalidates tag pages, so these windows are the only bound.
export function tagListFreshSeconds(page: number): number {
  return (
    (page === 1 ? TAG_LIST_FIRST_PAGE_FRESH_MS : TAG_LIST_PAGE_FRESH_MS) / 1000
  );
}

/**
 * One page (100 tags) of a repository's tag list, in GitHub's order. With
 * `dates`, each tag also carries its commit's committer date, fetched with
 * one GraphQL query per page. Only call this for a repo that passed the
 * visibility check.
 */
export async function getCachedGitHubTagList(
  env: Env,
  owner: string,
  repo: string,
  page: number,
  { dates = false }: { dates?: boolean } = {},
): Promise<{
  list: GitHubTagListPage;
  staleFallback: boolean;
  /** How long the page stays fresh: what is left of its KV freshness. */
  freshSeconds: number;
}> {
  if (!Number.isInteger(page) || page < 1 || page > TAG_LIST_MAX_PAGE) {
    throw new GitHubError(400, "Invalid page", new Headers());
  }
  const cacheRepository = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const freshMs = tagListFreshSeconds(page) * 1000;
  let staleFallback = false;
  let cachedAt = Date.now();
  const list = await getOrRefresh<GitHubTagListPage>({
    env,
    cacheKey: `github:${dates ? "tags-dated" : "tags"}:${cacheRepository}:${page}`,
    isFresh: (entry) => Date.now() - entry.cached_at < freshMs,
    fetcher: (token) => fetchGitHubTagList(owner, repo, page, dates, token),
    expirationTtl: () => CACHE_TTL_SECONDS,
    useStaleOnError: releaseStaleFallbackAllowed,
    onStaleFallback: () => {
      staleFallback = true;
    },
    onFreshEntry: (at) => {
      cachedAt = at;
    },
  });
  // The edge keeps a page only for what is left of its freshness, so a page
  // read from KV late in its window is not kept a whole window more.
  const freshSeconds = staleFallback
    ? 0
    : Math.max(1, Math.ceil((cachedAt + freshMs - Date.now()) / 1000));
  return { list, staleFallback, freshSeconds };
}

/**
 * Fetch a GitHub API URL with a pool token, marking the token when GitHub
 * rate-limits it. Errors are thrown as-is; read their status with
 * `githubStatus`.
 */
export async function githubPoolJson<T>(env: Env, url: string): Promise<T> {
  return withPoolToken(env, (token) => githubJson<T>(url, token));
}

/**
 * Run GitHub requests with one pool token, then bench the token if it ran
 * low, or mark it if GitHub rate-limited it. Errors are rethrown.
 */
export async function withPoolToken<T>(
  env: Env,
  run: (token: TokenRecord | null) => Promise<T>,
): Promise<T> {
  const token = await nextToken(env);
  try {
    const data = await run(token);
    await benchIfLow(env, token);
    return data;
  } catch (error) {
    if (isRateLimited(error) && token) {
      await markRateLimited(env, token.id, resetAt(error));
    } else {
      await benchIfLow(env, token);
    }
    throw error;
  }
}

async function getOrRefresh<T>({
  env,
  cacheKey,
  isFresh,
  fetcher,
  expirationTtl,
  useStaleOnError = () => true,
  staleCacheKey,
  onStaleFallback,
  onFetchError,
  onFreshEntry,
  beforeFetch,
  fingerprint,
}: {
  env: Env;
  cacheKey: string;
  isFresh: (entry: CacheEntry<T>) => boolean;
  fetcher: (token: TokenRecord | null) => Promise<T>;
  /** Runs when there is no fresh entry, before fetching; may throw. */
  beforeFetch?: () => Promise<void>;
  /**
   * Identifies equivalent data. When given, entries record since when their
   * data has been unchanged (`unchanged_since`) for `isFresh` to use.
   */
  fingerprint?: (data: T) => string;
  expirationTtl?: (data: T) => number | undefined;
  useStaleOnError?: (error: unknown) => boolean;
  staleCacheKey?: string;
  onStaleFallback?: () => void;
  /** Called with the `cached_at` of the entry served, unless it is stale. */
  onFreshEntry?: (cachedAt: number) => void;
  onFetchError?: (
    error: unknown,
    cached: CacheEntry<T> | null,
  ) => Promise<void>;
}): Promise<T> {
  const cached = await env.GITHUB_CACHE.get<CacheEntry<T>>(cacheKey, "json");
  if (cached && isFresh(cached)) {
    onFreshEntry?.(cached.cached_at);
    return cached.data;
  }
  await beforeFetch?.();

  const token = await nextToken(env);
  try {
    const data = await fetcher(token);
    await benchIfLow(env, token);
    const ttl = expirationTtl ? expirationTtl(data) : CACHE_TTL_SECONDS;
    const options = ttl === undefined ? undefined : { expirationTtl: ttl };
    const now = Date.now();
    const entry: CacheEntry<T> = { cached_at: now, data };
    onFreshEntry?.(now);
    if (fingerprint) {
      entry.unchanged_since =
        cached && sameData(fingerprint, cached.data, data)
          ? // Entries from before `unchanged_since` existed held this data
            // since at least when they were cached.
            Math.min(cached.unchanged_since ?? cached.cached_at, now)
          : now;
    }
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), options);
    return data;
  } catch (error) {
    if (isRateLimited(error) && token) {
      await markRateLimited(env, token.id, resetAt(error));
    } else {
      await benchIfLow(env, token);
    }
    await onFetchError?.(error, cached);
    if (cached && useStaleOnError(error)) {
      onStaleFallback?.();
      return cached.data;
    }
    if (staleCacheKey && useStaleOnError(error)) {
      try {
        const stale = await env.GITHUB_CACHE.get<CacheEntry<T>>(
          staleCacheKey,
          "json",
        );
        if (stale) {
          onStaleFallback?.();
          return stale.data;
        }
      } catch (cacheError) {
        console.warn("failed to read fallback GitHub cache entry:", cacheError);
      }
    }
    throw error;
  }
}

function sameData<T>(fingerprint: (data: T) => string, a: T, b: T): boolean {
  try {
    return fingerprint(a) === fingerprint(b);
  } catch {
    return false;
  }
}

async function nextToken(env: Env): Promise<TokenRecord | null> {
  try {
    const db = drizzle(env.DB);
    const database = setupDatabase(db);
    const token = await database.getNextToken();
    return token ? { id: token.id, token: token.token } : null;
  } catch (error) {
    console.warn("failed to get GitHub token:", error);
    return null;
  }
}

async function markRateLimited(env: Env, tokenId: number, reset?: string) {
  try {
    const db = drizzle(env.DB);
    const database = setupDatabase(db);
    await database.markTokenRateLimited(tokenId, reset);
  } catch (error) {
    console.warn(`failed to mark GitHub token ${tokenId} rate-limited:`, error);
  }
}

async function fetchGitHubRelease(
  owner: string,
  repo: string,
  tag: string,
  token: TokenRecord | null,
): Promise<GitHubRelease> {
  assertValidRepo(owner, repo);
  if (!validReleaseTag(tag)) {
    throw new GitHubError(400, "Invalid release tag", new Headers());
  }

  const path =
    tag === "latest"
      ? "releases/latest"
      : `releases/tags/${encodeURIComponent(tag)}`;
  const data = await githubJson<GitHubRelease>(
    `https://api.github.com/repos/${owner}/${repo}/${path}`,
    token,
  );
  // A draft is only visible to tokens with push access; never publish one.
  if (data.draft) {
    throw new DraftReleaseError(404, "Not found", new Headers());
  }
  const assets = data.assets ?? [];
  const immutable =
    assets.length > 0 &&
    tag !== "latest" &&
    !data.draft &&
    !data.prerelease &&
    (data.immutable === true ||
      (data.immutable === undefined &&
        releaseAgeImmutable(data.published_at ?? undefined)));

  return {
    tag_name: data.tag_name,
    draft: data.draft,
    prerelease: data.prerelease,
    created_at: data.created_at,
    published_at: data.published_at ?? null,
    updated_at: data.updated_at ?? null,
    immutable,
    assets: assets.map((asset) => ({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      url: asset.url,
      digest: asset.digest ?? null,
      updated_at: asset.updated_at ?? null,
    })),
  };
}

function releaseAgeImmutable(publishedAt: string | undefined): boolean {
  const timestamp = publishedAt ? new Date(publishedAt).getTime() : NaN;
  return (
    Number.isFinite(timestamp) &&
    Date.now() - timestamp > RELEASE_IMMUTABLE_AFTER_MS
  );
}

/** One page of a GitHub list, and what GitHub's Link header says follows. */
export interface GitHubListPage<T> {
  items: T[];
  /** GitHub links a next page; a full page may be the last. */
  hasNextPage: boolean;
  /** The page GitHub links as `rel="last"`, when it does. */
  lastPage: number | null;
  /** The size of GitHub's JSON for this page. */
  bytes: number;
}

async function fetchGitHubReleaseList(
  owner: string,
  repo: string,
  page: number,
  token: TokenRecord | null,
): Promise<GitHubReleaseListPage> {
  const { items, hasNextPage } = await fetchGitHubReleasePage(
    owner,
    repo,
    page,
    token,
  );
  return {
    releases: items,
    next_page: hasNextPage && page < RELEASE_LIST_MAX_PAGE ? page + 1 : null,
    truncated: hasNextPage && page >= RELEASE_LIST_MAX_PAGE,
  };
}

/** One page (100) of a repository's releases, drafts removed. */
export async function fetchGitHubReleasePage(
  owner: string,
  repo: string,
  page: number,
  token: TokenRecord | null,
  signal?: AbortSignal,
): Promise<GitHubListPage<GitHubListedRelease>> {
  assertValidRepo(owner, repo);
  const response = await fetchGitHubJsonResponse(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASE_LIST_PER_PAGE}&page=${page}`,
    token,
    signal,
  );
  const link = response.headers.get("link");
  const { data, bytes } =
    await readSizedJsonResponse<
      (GitHubListedRelease & { assets?: GitHubListedAsset[] })[]
    >(response);
  if (!Array.isArray(data)) {
    throw new GitHubError(
      502,
      "GitHub release list response was not an array",
      new Headers(),
    );
  }
  // Drafts are only visible to tokens with push access; never publish them.
  const releases = data
    .filter((release) => !release.draft)
    .map((release) => ({
      tag_name: release.tag_name,
      draft: release.draft,
      prerelease: release.prerelease,
      created_at: release.created_at,
      published_at: release.published_at ?? null,
      assets: (release.assets ?? []).map((asset) => ({
        name: asset.name,
        browser_download_url: asset.browser_download_url,
        url: asset.url,
        digest: asset.digest ?? null,
        updated_at: asset.updated_at ?? null,
      })),
    }));
  return {
    items: releases,
    hasNextPage: hasNextLink(link),
    lastPage: lastLinkPage(link),
    bytes,
  };
}

interface GitHubRestTag {
  name?: unknown;
  commit?: { sha?: unknown; url?: unknown } | null;
}

async function fetchGitHubTagList(
  owner: string,
  repo: string,
  page: number,
  dates: boolean,
  token: TokenRecord | null,
): Promise<GitHubTagListPage> {
  const { items, hasNextPage } = await fetchGitHubTagPage(
    owner,
    repo,
    page,
    dates,
    token,
  );
  return {
    tags: items,
    next_page: hasNextPage && page < TAG_LIST_MAX_PAGE ? page + 1 : null,
    truncated: hasNextPage && page >= TAG_LIST_MAX_PAGE,
  };
}

/**
 * One page (100) of a repository's tags, in GitHub's order. With `dates`,
 * each tag also carries its commit's committer date (one GraphQL query).
 */
export async function fetchGitHubTagPage(
  owner: string,
  repo: string,
  page: number,
  dates: boolean,
  token: TokenRecord | null,
  signal?: AbortSignal,
): Promise<GitHubListPage<GitHubTag>> {
  assertValidRepo(owner, repo);
  // Dates need GraphQL, which refuses anonymous requests. Fail before the
  // REST call too, so an empty pool doesn't spend the shared anonymous limit
  // on a page that can't be completed.
  if (dates && !token) throw noGraphQLTokenError();
  const response = await fetchGitHubJsonResponse(
    `https://api.github.com/repos/${owner}/${repo}/tags?per_page=${TAG_LIST_PER_PAGE}&page=${page}`,
    token,
    signal,
  );
  const link = response.headers.get("link");
  const { data, bytes } =
    await readSizedJsonResponse<GitHubRestTag[]>(response);
  if (!Array.isArray(data)) {
    throw new GitHubError(
      502,
      "GitHub tag list response was not an array",
      new Headers(),
    );
  }
  const tags: GitHubTag[] = data.map((tag) => {
    if (
      typeof tag?.name !== "string" ||
      typeof tag.commit?.sha !== "string" ||
      typeof tag.commit.url !== "string"
    ) {
      throw new GitHubError(
        502,
        "GitHub tag list entry was malformed",
        new Headers(),
      );
    }
    return {
      name: tag.name,
      commit: { sha: tag.commit.sha, url: tag.commit.url },
    };
  });
  if (dates && tags.length > 0) {
    const commitDates = await fetchGitHubCommitDates(
      owner,
      repo,
      tags.map((tag) => tag.commit.sha),
      token,
      signal,
    );
    for (const tag of tags) {
      tag.date = commitDates.get(tag.commit.sha) ?? null;
    }
  }
  return {
    items: tags,
    hasNextPage: hasNextLink(link),
    lastPage: lastLinkPage(link),
    bytes,
  };
}

const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";

function noGraphQLTokenError(): GitHubError {
  return new NoGraphQLTokenError(
    503,
    "No GitHub token for GraphQL commit dates",
    new Headers(),
  );
}

interface GitHubCommitDatesResponse {
  data?: {
    repository?: Record<string, { committedDate?: unknown } | null> | null;
  } | null;
  errors?: { type?: string; message?: string }[];
}

/**
 * Committer dates for up to 100 commits of one repository, keyed by SHA, in
 * one GraphQL query. GitHub charges it 1 point of the token's separate
 * GraphQL budget, where the REST equivalent is one request per commit.
 * Commits GitHub doesn't know are left out.
 */
async function fetchGitHubCommitDates(
  owner: string,
  repo: string,
  shas: string[],
  token: TokenRecord | null,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  // GitHub's GraphQL API refuses anonymous requests.
  if (!token) throw noGraphQLTokenError();
  const unique = [...new Set(shas)];
  if (unique.some((sha) => !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha))) {
    throw new GitHubError(
      502,
      "GitHub tag commit SHA was invalid",
      new Headers(),
    );
  }
  const declarations = ["$owner: String!", "$name: String!"];
  const fields: string[] = [];
  const variables: Record<string, string> = { owner, name: repo };
  unique.forEach((sha, i) => {
    declarations.push(`$c${i}: GitObjectID!`);
    fields.push(
      `c${i}: object(oid: $c${i}) { ... on Commit { committedDate } }`,
    );
    variables[`c${i}`] = sha;
  });
  const query = `query(${declarations.join(", ")}) { repository(owner: $owner, name: $name) { ${fields.join(" ")} } }`;

  const raw = await fetch(GITHUB_GRAPHQL_URL, {
    method: "POST",
    headers: {
      ...githubJsonHeaders(GITHUB_GRAPHQL_URL, token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
    redirect: "manual",
    signal,
  });
  // These headers report the GraphQL budget, which benchIfLow then holds to
  // the same floor as REST: volunteers' tokens are left alone once either
  // runs low.
  recordRateLimit(token, raw.headers);
  const response = await validateGitHubJsonResponse(raw, GITHUB_GRAPHQL_URL);
  const body = await readJsonResponse<GitHubCommitDatesResponse>(response);
  // GraphQL reports an exhausted budget as a 200 with a RATE_LIMITED error.
  // Treat it as the 403 REST would send, so the token is marked.
  const rateLimited = body.errors?.find(
    (error) => error.type === "RATE_LIMITED",
  );
  if (rateLimited) {
    throw new GitHubError(
      403,
      rateLimited.message ?? "GitHub GraphQL rate limit exceeded",
      response.headers,
      GITHUB_GRAPHQL_URL,
    );
  }
  // A commit GitHub doesn't know comes back as null with no error, so any
  // error means a failed lookup. Refuse the page rather than cache a missing
  // date in place of a real one; a stale entry is served instead.
  const repository = body.data?.repository;
  if (body.errors?.length || !repository) {
    throw new GitHubError(
      502,
      body.errors?.[0]?.message ?? "GitHub GraphQL returned no repository",
      new Headers(),
    );
  }
  const commitDates = new Map<string, string>();
  unique.forEach((sha, i) => {
    const date = repository[`c${i}`]?.committedDate;
    if (typeof date === "string") commitDates.set(sha, date);
  });
  return commitDates;
}

function hasNextLink(link: string | null): boolean {
  return (
    !!link &&
    link.split(",").some((part) => /;\s*rel="?next"?(\s*;|\s*$)/.test(part))
  );
}

function lastLinkPage(link: string | null): number | null {
  const part = link
    ?.split(",")
    .find((part) => /;\s*rel="?last"?(\s*;|\s*$)/.test(part));
  const url = part?.match(/<([^>]+)>/)?.[1];
  if (!url) return null;
  try {
    const page = Number(new URL(url).searchParams.get("page"));
    return Number.isInteger(page) && page >= 1 ? page : null;
  } catch {
    return null;
  }
}

async function fetchGitHubAttestations(
  owner: string,
  repo: string,
  digest: string,
  token: TokenRecord | null,
): Promise<GitHubAttestationsResponse> {
  assertValidRepo(owner, repo);
  if (!validDigest(digest)) {
    throw new GitHubError(400, "Invalid digest", new Headers());
  }

  let response: GitHubAttestationsResponse;
  try {
    response = await githubJson<GitHubAttestationsResponse>(
      `https://api.github.com/repos/${owner}/${repo}/attestations/${encodeURIComponent(digest)}?per_page=30`,
      token,
    );
  } catch (error) {
    if (githubStatus(error) === 404) {
      return { attestations: [] };
    }
    throw error;
  }
  const attestations = await Promise.all(
    (response.attestations ?? []).map((attestation) =>
      hydrateBundle(attestation, token),
    ),
  );
  return { attestations };
}

async function hydrateBundle(
  attestation: GitHubAttestation,
  token: TokenRecord | null,
): Promise<GitHubAttestation> {
  if (attestation.bundle) {
    return attestation;
  }
  if (!attestation.bundle_url) {
    throw new GitHubError(
      502,
      "GitHub attestation did not include bundle data",
      new Headers(),
    );
  }
  if (!validGitHubAttestationBundleUrl(attestation.bundle_url)) {
    throw new GitHubError(
      502,
      "Invalid GitHub attestation bundle URL",
      new Headers(),
    );
  }
  return {
    ...attestation,
    bundle: await githubJson(attestation.bundle_url, token),
  };
}

function recordRateLimit(token: TokenRecord | null, headers: Headers) {
  if (!token) return;
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (
    headers.get("x-ratelimit-remaining") === null ||
    !Number.isFinite(remaining)
  )
    return;
  // Parallel requests share this token object and can finish out of order;
  // keep the lowest reading seen so a late, higher one can't hide a low token.
  if (token.remaining !== undefined && token.remaining <= remaining) return;
  token.remaining = remaining;
  if (Number.isFinite(reset) && reset > 0) {
    token.rateLimitReset = new Date(reset * 1000).toISOString();
  }
}

// Volunteers' tokens are left alone once they run low, however the requests
// were spent. Called after each use, using the headers GitHub already sent.
async function benchIfLow(env: Env, token: TokenRecord | null) {
  if (token?.remaining === undefined || hasBudget(token.remaining)) return;
  await markRateLimited(env, token.id, token.rateLimitReset);
}

async function githubJson<T>(
  url: string,
  token: TokenRecord | null,
): Promise<T> {
  const response = await fetchGitHubJsonResponse(url, token);
  return readJsonResponse(response);
}

async function fetchGitHubJsonResponse(
  url: string,
  token: TokenRecord | null,
  signal?: AbortSignal,
): Promise<Response> {
  const maxRedirects = 3;
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount++) {
    const headers = githubJsonHeaders(currentUrl, token);
    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
      signal,
    });
    recordRateLimit(token, response.headers);
    if (isGitHubApiRedirect(response)) {
      await response.body?.cancel();
      if (redirectCount >= maxRedirects) {
        throw new GitHubError(
          502,
          "GitHub API redirect limit exceeded",
          response.headers,
          currentUrl,
        );
      }
      const nextUrl = redirectedGitHubApiUrl(currentUrl, response);
      if (!nextUrl) {
        throw new GitHubError(
          502,
          "GitHub API redirect location was invalid",
          response.headers,
          currentUrl,
        );
      }
      currentUrl = nextUrl;
      continue;
    }

    return validateGitHubJsonResponse(response, currentUrl);
  }
}

async function validateGitHubJsonResponse(
  response: Response,
  url: string,
): Promise<Response> {
  if (response.status === 404) {
    throw new GitHubError(404, "Not found", response.headers, url);
  }
  if (!response.ok) {
    throw new GitHubError(
      response.status,
      await response.text(),
      response.headers,
      url,
    );
  }
  return response;
}

function isGitHubApiRedirect(response: Response): boolean {
  return (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.has("location")
  );
}

function redirectedGitHubApiUrl(
  currentUrl: string,
  response: Response,
): string | null {
  const location = response.headers.get("location");
  if (!location || !isGitHubApiUrl(currentUrl)) {
    return null;
  }
  try {
    const nextUrl = new URL(location, currentUrl);
    return nextUrl.hostname === "api.github.com" ? nextUrl.toString() : null;
  } catch {
    return null;
  }
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  return (await readSizedJsonResponse<T>(response)).data;
}

/** The parsed body, and how long its JSON text was. */
async function readSizedJsonResponse<T>(
  response: Response,
): Promise<{ data: T; bytes: number }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const json =
    contentType.split(";")[0].trim() === "application/x-snappy"
      ? new TextDecoder().decode(
          uncompress(new Uint8Array(await response.arrayBuffer())),
        )
      : await response.text();
  return { data: JSON.parse(json), bytes: json.length };
}

function assertValidRepo(owner: string, repo: string) {
  if (!validRepoPart(owner) || !validRepoPart(repo)) {
    throw new GitHubError(
      400,
      "Invalid owner or repository name",
      new Headers(),
    );
  }
}

function validGitHubAttestationBundleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "api.github.com" ||
        url.hostname.endsWith(".blob.core.windows.net"))
    );
  } catch {
    return false;
  }
}

function isGitHubApiUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    return new URL(value).hostname === "api.github.com";
  } catch {
    return false;
  }
}

function githubJsonHeaders(
  url: string,
  token: TokenRecord | null,
): Record<string, string> {
  const isGitHub = isGitHubApiUrl(url);
  const headers: Record<string, string> = {
    "User-Agent": "mise-versions (https://github.com/jdx/mise-versions)",
  };
  if (isGitHub) {
    headers.Accept = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  }
  if (token && isGitHub) {
    headers.Authorization = `Bearer ${token.token}`;
  }
  return headers;
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof GitHubError &&
    isGitHubApiUrl(error.url) &&
    (error.status === 429 ||
      (error.status === 403 &&
        (error.headers.has("x-ratelimit-reset") ||
          error.headers.has("retry-after"))))
  );
}

function resetAt(error: unknown): string | undefined {
  if (!(error instanceof GitHubError)) {
    return undefined;
  }
  const reset = error.headers.get("x-ratelimit-reset");
  if (reset) {
    const epochSeconds = Number(reset);
    return Number.isFinite(epochSeconds)
      ? new Date(epochSeconds * 1000).toISOString()
      : undefined;
  }
  const retryAfter = error.headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }
  const retryAfterSeconds = Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds)) {
    return new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
  }
  const retryAfterDate = new Date(retryAfter);
  return Number.isFinite(retryAfterDate.getTime())
    ? retryAfterDate.toISOString()
    : undefined;
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Headers,
    readonly url?: string,
  ) {
    super(message);
  }
}

/** A release GitHub showed the pool as a draft; served as a 404. */
class DraftReleaseError extends GitHubError {}

/** Tag dates were asked for, but the pool has no token for GraphQL. */
export class NoGraphQLTokenError extends GitHubError {}

/** An error served from the negative release cache. */
class CachedReleaseError extends GitHubError {}

export const __testing = {
  GitHubError,
  attestationFreshMs,
  attestationsFingerprint,
  edgeCacheRequest,
  edgeCacheResponse,
  fetchGitHubTagList,
  githubJsonHeaders,
  hasNextLink,
  lastLinkPage,
  isGitHubApiUrl,
  isRateLimited,
  resetAt,
  validGitHubAttestationBundleUrl,
};
