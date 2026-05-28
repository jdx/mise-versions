import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "../../../../src/database";

const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const RELEASE_FRESH_MS = 6 * 60 * 60 * 1000;
const RELEASE_IMMUTABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const NEGATIVE_ATTESTATION_FRESH_MS = 30 * 60 * 1000;

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

export function cacheHeaders(maxAge = 600): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${maxAge}, stale-while-revalidate=86400`,
  };
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
  return getOrRefresh({
    env,
    cacheKey: `github:release:${owner}/${repo}:${tag}`,
    isFresh: (entry) =>
      (tag !== "latest" && entry.data.immutable === true) ||
      Date.now() - entry.cached_at < RELEASE_FRESH_MS,
    fetcher: (token) => fetchGitHubRelease(owner, repo, tag, token),
    expirationTtl: (data) =>
      tag !== "latest" && data.immutable === true
        ? undefined
        : CACHE_TTL_SECONDS,
  });
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
  const immutable =
    tag !== "latest" &&
    !data.draft &&
    !data.prerelease &&
    Number.isFinite(publishedAt) &&
    Date.now() - publishedAt > RELEASE_IMMUTABLE_AFTER_MS;
  const assets = data.assets ?? [];
  if (assets.length === 0) {
    throw new GitHubError(
      502,
      "GitHub release response did not include assets",
      new Headers(),
    );
  }

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
  if (!validGitHubApiUrl(attestation.bundle_url)) {
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
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "mise-versions (https://github.com/jdx/mise-versions)",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) {
    headers.Authorization = `Bearer ${token.token}`;
  }
  const response = await fetch(url, { headers, redirect: "error" });
  if (response.status === 404) {
    throw new GitHubError(404, "Not found", response.headers);
  }
  if (!response.ok) {
    throw new GitHubError(
      response.status,
      await response.text(),
      response.headers,
    );
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

function validGitHubApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.github.com";
  } catch {
    return false;
  }
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof GitHubError &&
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
  ) {
    super(message);
  }
}
