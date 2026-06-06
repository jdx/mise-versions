import { drizzle } from "drizzle-orm/d1";
import { uncompress } from "snappyjs";
import { setupDatabase } from "../../../../src/database";

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const RELEASE_FRESH_MS = 6 * 60 * 60 * 1000;
const EMPTY_RELEASE_FRESH_MS = 30 * 60 * 1000;
const EMPTY_RELEASE_CACHE_TTL_SECONDS = 30 * 60;
const RELEASE_IMMUTABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_RELEASE_NOT_FOUND_FRESH_MS = 30 * 60 * 1000;
const NEGATIVE_RELEASE_AUTH_FRESH_MS = 5 * 60 * 1000;
const NEGATIVE_RELEASE_TRANSIENT_FRESH_MS = 60 * 1000;
const NEGATIVE_ATTESTATION_FRESH_MS = 30 * 60 * 1000;
const EDGE_SHORT_TTL_SECONDS = 10 * 60;
const EDGE_NEGATIVE_ATTESTATION_TTL_SECONDS = 30 * 60;
const EDGE_IMMUTABLE_TTL_SECONDS = 365 * 24 * 60 * 60;

interface CacheEntry<T> {
  cached_at: number;
  data: T;
}

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  url: string;
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  immutable?: boolean;
  assets: GitHubAsset[];
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

interface TokenRecord {
  id: number;
  token: string;
}

export function cacheHeaders({
  browserMaxAge = 600,
  edgeMaxAge = EDGE_SHORT_TTL_SECONDS,
  immutable = false,
}: {
  browserMaxAge?: number;
  edgeMaxAge?: number;
  immutable?: boolean;
} = {}): Record<string, string> {
  const directives = [
    `public`,
    `max-age=${browserMaxAge}`,
    `s-maxage=${edgeMaxAge}`,
  ];
  if (immutable) {
    directives.push("immutable");
  } else {
    directives.push("stale-while-revalidate=86400");
  }
  return {
    "Cache-Control": directives.join(", "),
  };
}

export function releaseCacheHeaders(tag: string, release: GitHubRelease) {
  const immutable = tag !== "latest" && release.immutable === true;
  return cacheHeaders({
    edgeMaxAge: immutable ? EDGE_IMMUTABLE_TTL_SECONDS : EDGE_SHORT_TTL_SECONDS,
    immutable,
  });
}

export function attestationsCacheHeaders(response: GitHubAttestationsResponse) {
  const positive = response.attestations.length > 0;
  return cacheHeaders({
    edgeMaxAge: positive
      ? EDGE_IMMUTABLE_TTL_SECONDS
      : EDGE_NEGATIVE_ATTESTATION_TTL_SECONDS,
    immutable: positive,
  });
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
  return !!value && /^[A-Za-z0-9_.\/:+-]+$/.test(value);
}

export function validDigest(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_.-]+:[A-Fa-f0-9]+$/.test(value);
}

export function githubStatus(error: unknown): number | null {
  return error instanceof GitHubError ? error.status : null;
}

export async function getCachedGitHubRelease(
  env: Env,
  owner: string,
  repo: string,
  tag: string,
): Promise<GitHubRelease> {
  const cacheKey = `github:release:${owner}/${repo}:${tag}`;
  const negativeCacheKey = `github:release-error:${owner}/${repo}:${tag}`;
  const cachedError = await cachedReleaseError(env, negativeCacheKey);
  if (cachedError) {
    throw cachedError;
  }

  let release: GitHubRelease;
  try {
    release = await getOrRefresh({
      env,
      cacheKey,
      isFresh: (entry) =>
        (tag !== "latest" && entry.data.immutable === true) ||
        Date.now() - entry.cached_at <
          (entry.data.assets.length === 0
            ? EMPTY_RELEASE_FRESH_MS
            : RELEASE_FRESH_MS),
      fetcher: (token) => fetchGitHubRelease(owner, repo, tag, token),
      expirationTtl: (data) =>
        data.assets.length === 0
          ? EMPTY_RELEASE_CACHE_TTL_SECONDS
          : tag !== "latest" && data.immutable === true
            ? undefined
            : CACHE_TTL_SECONDS,
      useStaleOnError: releaseStaleFallbackAllowed,
      onFetchError: async (error) => {
        if (githubStatus(error) === 404) {
          await deleteCachedRelease(env, cacheKey);
        }
      },
    });
  } catch (error) {
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
  await clearCachedReleaseError(env, negativeCacheKey);
  return release;
}

async function cachedReleaseError(
  env: Env,
  cacheKey: string,
): Promise<GitHubError | null> {
  const cached = await env.GITHUB_CACHE.get<CacheEntry<CachedGitHubError>>(
    cacheKey,
    "json",
  );
  if (!cached) {
    return null;
  }
  const freshMs = releaseErrorFreshMs(cached.data.status);
  if (!freshMs || Date.now() - cached.cached_at >= freshMs) {
    return null;
  }
  return new GitHubError(
    cached.data.status,
    cached.data.message,
    new Headers(),
  );
}

async function cacheReleaseError(
  env: Env,
  cacheKey: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof GitHubError)) {
    return;
  }
  const freshMs = releaseErrorFreshMs(error.status, error);
  if (!freshMs) {
    return;
  }
  await env.GITHUB_CACHE.put(
    cacheKey,
    JSON.stringify({
      cached_at: Date.now(),
      data: {
        status: error.status,
        message: error.message,
      },
    }),
    { expirationTtl: Math.ceil(freshMs / 1000) },
  );
}

async function clearCachedReleaseError(
  env: Env,
  cacheKey: string,
): Promise<void> {
  try {
    await env.GITHUB_CACHE.delete?.(cacheKey);
  } catch (error) {
    console.warn("failed to clear GitHub release negative cache:", error);
  }
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

function releaseStaleFallbackAllowed(error: unknown): boolean {
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
    isFresh: (entry) => {
      if (entry.data.attestations.length > 0) {
        return true;
      }
      const age = Date.now() - entry.cached_at;
      return age < NEGATIVE_ATTESTATION_FRESH_MS;
    },
    fetcher: (token) => fetchGitHubAttestations(owner, repo, digest, token),
    expirationTtl: (data) =>
      data.attestations.length > 0 ? undefined : CACHE_TTL_SECONDS,
  });
}

async function getOrRefresh<T>({
  env,
  cacheKey,
  isFresh,
  fetcher,
  expirationTtl,
  useStaleOnError = () => true,
  onFetchError,
}: {
  env: Env;
  cacheKey: string;
  isFresh: (entry: CacheEntry<T>) => boolean;
  fetcher: (token: TokenRecord | null) => Promise<T>;
  expirationTtl?: (data: T) => number | undefined;
  useStaleOnError?: (error: unknown) => boolean;
  onFetchError?: (error: unknown) => Promise<void>;
}): Promise<T> {
  const cached = await env.GITHUB_CACHE.get<CacheEntry<T>>(cacheKey, "json");
  if (cached && isFresh(cached)) {
    return cached.data;
  }

  const token = await nextToken(env);
  try {
    const data = await fetcher(token);
    const ttl = expirationTtl ? expirationTtl(data) : CACHE_TTL_SECONDS;
    const options = ttl === undefined ? undefined : { expirationTtl: ttl };
    await env.GITHUB_CACHE.put(
      cacheKey,
      JSON.stringify({ cached_at: Date.now(), data }),
      options,
    );
    return data;
  } catch (error) {
    if (isRateLimited(error) && token) {
      await markRateLimited(env, token.id, resetAt(error));
    }
    await onFetchError?.(error);
    if (cached && useStaleOnError(error)) {
      return cached.data;
    }
    throw error;
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
  const data = await githubJson<GitHubRelease & { published_at?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/${path}`,
    token,
  );
  const publishedAt = data.published_at
    ? new Date(data.published_at).getTime()
    : NaN;
  const assets = data.assets ?? [];
  const immutable =
    assets.length > 0 &&
    tag !== "latest" &&
    !data.draft &&
    !data.prerelease &&
    Number.isFinite(publishedAt) &&
    Date.now() - publishedAt > RELEASE_IMMUTABLE_AFTER_MS;

  return {
    tag_name: data.tag_name,
    draft: data.draft,
    prerelease: data.prerelease,
    created_at: data.created_at,
    immutable,
    assets: assets.map((asset) => ({
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      url: asset.url,
      digest: asset.digest ?? null,
    })),
  };
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
): Promise<Response> {
  const maxRedirects = 3;
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount++) {
    const headers = githubJsonHeaders(currentUrl, token);
    const response = await fetch(currentUrl, { headers, redirect: "manual" });
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
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.split(";")[0].trim() === "application/x-snappy") {
    const bytes = await response.arrayBuffer();
    const json = new TextDecoder().decode(uncompress(new Uint8Array(bytes)));
    return JSON.parse(json);
  }
  return response.json();
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

class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Headers,
    readonly url?: string,
  ) {
    super(message);
  }
}

export const __testing = {
  GitHubError,
  githubJsonHeaders,
  isGitHubApiUrl,
  isRateLimited,
  resetAt,
  validGitHubAttestationBundleUrl,
};
