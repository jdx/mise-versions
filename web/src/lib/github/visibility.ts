import { errorResponse } from "../api";
import { readThroughMemoEntry } from "./edge-memo";
import { githubPoolJson, githubStatus } from "./mirror";
import {
  isKnownGitHubAttestationRepo,
  isRegisteredGitHubRepo,
} from "./registry";

// How long a visibility answer is trusted after GitHub gave it. Caching "not
// public" as well keeps requests for random or private repos from spending
// pool quota, and the window bounds how long a repo that turns private can
// still be served. The KV entry's answer and its edge memo (edge-memo.ts)
// both expire this long after the GitHub check. The GitHub-mirror snippet
// (snippets/github-mirror-cache.js) keeps the same bound for the entries it
// serves without the Worker.
export const VISIBILITY_TTL_SECONDS = 60 * 60;
// Established public repos are re-checked once a day instead (see
// visibilityTtlSeconds). The answer is the same nearly every time, and the
// hourly re-check was a fifth of all GITHUB_CACHE writes. The trade-off: such
// a repo that turns private, or is taken down, may keep having its cached
// release, release-list and attestation metadata (and its baked version
// lists) served for up to 24 hours. GITHUB_MIRROR_ACCESS is not part of this
// answer and still applies on the hourly schedule.
export const POPULAR_VISIBILITY_TTL_SECONDS = 24 * 60 * 60;
// "Established": more than this many stars, or seen public by the mirror for
// longer than PUBLIC_FOR_MS.
export const POPULAR_MIN_STARS = 100;
export const PUBLIC_FOR_MS = 30 * 24 * 60 * 60 * 1000;
// `first_public_at` (when the mirror first saw the repo public) carries over
// from one check to the next only across a gap shorter than this: a repo
// nobody asked about for longer may have been private in between.
const MAX_PUBLIC_GAP_MS = 7 * 24 * 60 * 60 * 1000;
// The KV entry outlives its answer so the next check can read
// `first_public_at` from it. Whether the answer is still valid is decided by
// `cached_at` and `ttl`, never by the entry's existence.
const VISIBILITY_KV_EXPIRATION_SECONDS =
  MAX_PUBLIC_GAP_MS / 1000 + 24 * 60 * 60;

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  GITHUB_CACHE: KVNamespace;
  GITHUB_MIRROR_ACCESS?: string;
  // Bounds how many uncached lookups one client can make. Negative caching
  // only helps with repeated names; this stops a stream of unique names from
  // spending the token pool.
  GITHUB_VISIBILITY_LIMITER?: RateLimiter;
}

/** A client made too many uncached visibility lookups. */
export class VisibilityLookupLimited extends Error {}

interface GitHubRepoVisibility {
  private?: unknown;
  visibility?: unknown;
  stargazers_count?: unknown;
}

interface CachedVisibility {
  cached_at: number;
  public: boolean;
  /** How long the answer is trusted, in seconds; absent means an hour. */
  ttl?: number;
  /**
   * When the mirror first saw the repo public, in this unbroken run of
   * public answers (epoch ms). Absent when not public.
   */
  first_public_at?: number;
}

/** The memoized answer: public, and its TTL in seconds. */
interface MemoizedVisibility {
  p: boolean;
  t: number;
}

/** The TTL a stored answer was given, clamped to what this code allows. */
function storedTtlSeconds(ttl: unknown): number {
  return typeof ttl === "number" &&
    Number.isFinite(ttl) &&
    ttl >= VISIBILITY_TTL_SECONDS
    ? Math.min(ttl, POPULAR_VISIBILITY_TTL_SECONDS)
    : VISIBILITY_TTL_SECONDS;
}

/**
 * How long to trust an answer: a day for a public repo with more than
 * POPULAR_MIN_STARS stars or seen public for more than PUBLIC_FOR_MS, an
 * hour otherwise. Not using GitHub's `created_at`: a repo can be created
 * private and made public later.
 */
export function visibilityTtlSeconds({
  isPublic,
  stars,
  firstPublicAt,
  now,
}: {
  isPublic: boolean;
  stars: unknown;
  firstPublicAt: number | undefined;
  now: number;
}): number {
  if (!isPublic) return VISIBILITY_TTL_SECONDS;
  const popular =
    (typeof stars === "number" && stars > POPULAR_MIN_STARS) ||
    (firstPublicAt !== undefined && now - firstPublicAt > PUBLIC_FOR_MS);
  return popular ? POPULAR_VISIBILITY_TTL_SECONDS : VISIBILITY_TTL_SECONDS;
}

export type GitHubMirrorAccess = "public" | "registry" | "off";

export function gitHubMirrorAccess(
  value: string | undefined,
): GitHubMirrorAccess {
  return value === "registry" || value === "off" ? value : "public";
}

/**
 * Whether GitHub reports the repository as public. The pool's tokens may be
 * able to read private repositories, so the mirror must ask rather than rely
 * on a fetch failing. Anything other than an explicit public answer is
 * treated as private.
 */
export async function isPublicGitHubRepo(
  env: Env,
  owner: string,
  repo: string,
  options: { clientKey?: string } = {},
): Promise<boolean> {
  return (await gitHubRepoVisibility(env, owner, repo, options)).public;
}

export interface GitHubRepoVisibilityAnswer {
  public: boolean;
  /** Epoch ms when GitHub gave this answer. */
  checkedAt: number;
  /** How long after `checkedAt` the answer is trusted, in seconds. */
  ttlSeconds: number;
}

/** isPublicGitHubRepo, plus when GitHub gave the answer. */
export async function gitHubRepoVisibility(
  env: Env,
  owner: string,
  repo: string,
  { clientKey }: { clientKey?: string } = {},
): Promise<GitHubRepoVisibilityAnswer> {
  const cacheKey = `github:visibility:${owner.toLowerCase()}/${repo.toLowerCase()}`;
  // Every mirror request asks this before anything else, so serve it from
  // the free memo tier when possible. A memoized answer expires when the KV
  // answer it copies would, so a repo that turns private is still cut off
  // within its TTL of the last check, as without the memo.
  // The memo holds { p, t }, under a key of its own: a Worker from before
  // TTLs memoized a bare boolean under `cacheKey`, and would read an object
  // there as truthy (public) while both versions run.
  const answer = await readThroughMemoEntry<MemoizedVisibility>(
    env.GITHUB_CACHE,
    `${cacheKey}#ttl`,
    async () => {
      const entry = await lookUpVisibility(
        env,
        cacheKey,
        owner,
        repo,
        clientKey,
      );
      const ttl = storedTtlSeconds(entry.ttl);
      return {
        value: { p: entry.public, t: ttl },
        expiresAt: Math.min(entry.cached_at, Date.now()) + ttl * 1000,
      };
    },
    // A lookup refused by one client's rate limit says nothing about others.
    { callerSpecific: (error) => error instanceof VisibilityLookupLimited },
  );
  const ttlSeconds = storedTtlSeconds(answer.value?.t);
  // Every answer expires its TTL after GitHub gave it.
  return {
    public: answer.value?.p === true,
    checkedAt: answer.expiresAt - ttlSeconds * 1000,
    ttlSeconds,
  };
}

async function lookUpVisibility(
  env: Env,
  cacheKey: string,
  owner: string,
  repo: string,
  clientKey: string | undefined,
): Promise<CachedVisibility> {
  const cached = await env.GITHUB_CACHE.get<CachedVisibility>(cacheKey, "json");
  const valid =
    !!cached &&
    typeof cached.public === "boolean" &&
    typeof cached.cached_at === "number";
  if (
    valid &&
    Date.now() - cached.cached_at < storedTtlSeconds(cached.ttl) * 1000
  ) {
    return cached;
  }

  if (
    env.GITHUB_VISIBILITY_LIMITER &&
    !(
      await env.GITHUB_VISIBILITY_LIMITER.limit({
        key: clientKey ?? "unknown",
      })
    ).success
  ) {
    throw new VisibilityLookupLimited();
  }

  let isPublic: boolean;
  let stars: unknown;
  try {
    const data = await githubPoolJson<GitHubRepoVisibility>(
      env,
      `https://api.github.com/repos/${owner}/${repo}`,
    );
    isPublic = data.private === false && data.visibility === "public";
    stars = data.stargazers_count;
  } catch (error) {
    const status = githubStatus(error);
    // Missing, or blocked for legal reasons: definitively not servable.
    // Anything else (rate limits, 5xx, network) is not an answer.
    if (status !== 404 && status !== 451) {
      throw error;
    }
    isPublic = false;
  }

  const now = Date.now();
  // The public run continues from the previous answer only if that was
  // public too, recent enough, and itself recorded when the run began.
  // Entries from before this field start the clock now.
  const firstPublicAt = !isPublic
    ? undefined
    : valid &&
        cached.public &&
        typeof cached.first_public_at === "number" &&
        cached.first_public_at <= now &&
        now - cached.cached_at < MAX_PUBLIC_GAP_MS
      ? cached.first_public_at
      : now;
  const entry: CachedVisibility = {
    cached_at: now,
    public: isPublic,
    ttl: visibilityTtlSeconds({ isPublic, stars, firstPublicAt, now }),
    ...(firstPublicAt === undefined ? {} : { first_public_at: firstPublicAt }),
  };
  try {
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(entry), {
      expirationTtl: VISIBILITY_KV_EXPIRATION_SECONDS,
    });
  } catch (error) {
    // The answer stands; once the memo expires the next request asks GitHub
    // again.
    console.warn(
      `failed to cache GitHub visibility for ${owner}/${repo}:`,
      error,
    );
  }
  return entry;
}

/**
 * Decide whether the mirror may serve this repository. Returns the error
 * response to send, or null to proceed. Call it before reading any cache.
 *
 * A private or missing repo gets a 404, like GitHub, so its existence is not
 * revealed and mise clients fall back quietly. A mirror that has been
 * restricted or disabled answers 403, which mise clients report as a
 * warning. `clientKey` identifies the caller for the lookup rate limit.
 */
export async function checkGitHubMirrorAccess(
  env: Env,
  owner: string,
  repo: string,
  options: { attestations?: boolean; clientKey?: string } = {},
): Promise<Response | null> {
  const result = await checkGitHubMirrorAccessVerified(
    env,
    owner,
    repo,
    options,
  );
  return result.denied;
}

export type GitHubMirrorAccessResult =
  | { denied: Response; verifiedAt?: undefined; verifiedUntil?: undefined }
  | {
      denied: null;
      /** Epoch ms when GitHub last confirmed the repo is public. */
      verifiedAt: number;
      /**
       * Epoch ms after which a response served on this grant must not be
       * served without checking access again: the visibility answer's TTL,
       * and at most VISIBILITY_TTL_SECONDS from now, so GITHUB_MIRROR_ACCESS
       * changes still reach cached copies within the hour.
       */
      verifiedUntil: number;
    };

/** checkGitHubMirrorAccess, plus when the visibility it relied on was checked. */
export async function checkGitHubMirrorAccessVerified(
  env: Env,
  owner: string,
  repo: string,
  {
    attestations = false,
    clientKey,
  }: { attestations?: boolean; clientKey?: string } = {},
): Promise<GitHubMirrorAccessResult> {
  const denied = (response: Response) => ({ denied: response });
  const access = gitHubMirrorAccess(env.GITHUB_MIRROR_ACCESS);
  if (access === "off") {
    return denied(errorResponse("GitHub mirror is disabled", 403));
  }

  if (access === "registry") {
    let registered: boolean;
    try {
      registered =
        (attestations && isKnownGitHubAttestationRepo(owner, repo)) ||
        (await isRegisteredGitHubRepo(env.ANALYTICS_DB, owner, repo));
    } catch (error) {
      console.error(
        `GitHub registry check failed for ${owner}/${repo}:`,
        error,
      );
      return denied(errorResponse("Failed to check GitHub repo registry", 503));
    }
    if (!registered) {
      return denied(
        errorResponse("GitHub repo is not in the mise registry", 403),
      );
    }
  }

  let visibility: GitHubRepoVisibilityAnswer;
  try {
    visibility = await gitHubRepoVisibility(env, owner, repo, { clientKey });
  } catch (error) {
    if (error instanceof VisibilityLookupLimited) {
      return denied(errorResponse("Too many uncached repository lookups", 429));
    }
    console.error(
      `GitHub visibility check failed for ${owner}/${repo}:`,
      error,
    );
    return denied(errorResponse("Failed to check GitHub repo visibility", 503));
  }
  return visibility.public
    ? {
        denied: null,
        verifiedAt: visibility.checkedAt,
        verifiedUntil: Math.min(
          visibility.checkedAt + visibility.ttlSeconds * 1000,
          Date.now() + VISIBILITY_TTL_SECONDS * 1000,
        ),
      }
    : denied(errorResponse("Not found", 404));
}
