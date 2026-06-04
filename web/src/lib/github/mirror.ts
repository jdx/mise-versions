import { drizzle } from "drizzle-orm/d1";
import { uncompress } from "snappyjs";
import { setupDatabase } from "../../../../src/database";

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const RELEASE_FRESH_MS = 6 * 60 * 60 * 1000;
const EMPTY_RELEASE_FRESH_MS = 30 * 60 * 1000;
const EMPTY_RELEASE_CACHE_TTL_SECONDS = 30 * 60;
const RELEASE_IMMUTABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_ATTESTATION_FRESH_MS = 30 * 60 * 1000;
const EDGE_SHORT_TTL_SECONDS = 10 * 60;
const EDGE_NEGATIVE_ATTESTATION_TTL_SECONDS = 30 * 60;
const EDGE_IMMUTABLE_TTL_SECONDS = 365 * 24 * 60 * 60;
const MAX_GITHUB_REDIRECTS = 3;

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
  const release = await getOrRefresh({
    env,
    cacheKey: `github:release:${owner}/${repo}:${tag}`,
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
  });
  if (release.assets.length === 0) {
    throw new GitHubError(
      404,
      "GitHub release response did not include assets",
      new Headers(),
    );
  }
  return release;
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
}: {
  env: Env;
  cacheKey: string;
  isFresh: (entry: CacheEntry<T>) => boolean;
  fetcher: (token: TokenRecord | null) => Promise<T>;
  expirationTtl?: (data: T) => number | undefined;
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
    if (cached) {
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
    assets: assets.map((asset) => normalizeGitHubAsset(asset, owner, repo)),
  };
}

function normalizeGitHubAsset(
  asset: GitHubAsset,
  owner: string,
  repo: string,
): GitHubAsset {
  return {
    name: asset.name,
    browser_download_url: withRequestedGitHubRepo(
      asset.browser_download_url,
      owner,
      repo,
    ),
    url: withRequestedGitHubRepo(asset.url, owner, repo),
    digest: asset.digest ?? null,
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
  let currentUrl = url;
  for (let redirects = 0; redirects <= MAX_GITHUB_REDIRECTS; redirects++) {
    const headers = githubJsonHeaders(currentUrl, token);
    const response = await fetch(currentUrl, { headers, redirect: "manual" });
    if (isRedirect(response.status)) {
      const nextUrl = githubRedirectUrl(currentUrl, response);
      if (nextUrl) {
        if (redirects >= MAX_GITHUB_REDIRECTS) {
          throw new GitHubError(
            508,
            "Too many GitHub redirects",
            response.headers,
            currentUrl,
          );
        }
        currentUrl = nextUrl;
        continue;
      }
    }
    if (response.status === 404) {
      throw new GitHubError(404, "Not found", response.headers, currentUrl);
    }
    if (!response.ok) {
      throw new GitHubError(
        response.status,
        await response.text(),
        response.headers,
        currentUrl,
      );
    }
    return readJsonResponse(response);
  }
  throw new GitHubError(508, "Too many GitHub redirects", new Headers(), url);
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

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function githubRedirectUrl(
  currentUrl: string,
  response: Response,
): string | null {
  const location = response.headers.get("location");
  if (!location || !isGitHubApiUrl(currentUrl)) {
    return null;
  }
  try {
    const nextUrl = new URL(location, currentUrl).toString();
    return isGitHubApiUrl(nextUrl) ? nextUrl : null;
  } catch {
    return null;
  }
}

function withRequestedGitHubRepo(
  value: string,
  owner: string,
  repo: string,
): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return value;
    }
    const segments = url.pathname.split("/");
    if (
      url.hostname === "github.com" &&
      segments.length >= 6 &&
      segments[3] === "releases" &&
      segments[4] === "download"
    ) {
      segments[1] = owner;
      segments[2] = repo;
      url.pathname = segments.join("/");
      return url.toString();
    }
    if (
      url.hostname === "api.github.com" &&
      segments.length === 7 &&
      segments[1] === "repos" &&
      segments[4] === "releases" &&
      segments[5] === "assets"
    ) {
      segments[2] = owner;
      segments[3] = repo;
      url.pathname = segments.join("/");
      return url.toString();
    }
    return value;
  } catch {
    return value;
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
    (error.status === 403 || error.status === 429)
  );
}

function resetAt(error: unknown): string | undefined {
  if (!(error instanceof GitHubError)) {
    return undefined;
  }
  const reset = error.headers.get("x-ratelimit-reset");
  if (!reset) {
    return undefined;
  }
  const epochSeconds = Number(reset);
  return Number.isFinite(epochSeconds)
    ? new Date(epochSeconds * 1000).toISOString()
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
  githubRedirectUrl,
  isGitHubApiUrl,
  isRateLimited,
  validGitHubAttestationBundleUrl,
  withRequestedGitHubRepo,
};
