// Cloudflare Snippet that answers GitHub-mirror requests from the colo's
// Cache API entries the Worker wrote, so a cache hit does not invoke (and
// bill) the Worker. Anything it cannot answer is passed to the Worker with
// `fetch(request)`. Deployed with `node scripts/deploy-snippet.js`; see
// CLAUDE.md.
//
// The Worker (web/src/lib/github/mirror.ts) imports the key and response
// helpers below, so both sides agree on them by construction.
//
// Snippet limits: 5 ms CPU, 2 MB memory, 32 KB package. Keep this to one
// cache lookup, a few header reads, and a streamed body.

// Bump the version when the stored entry's shape or meaning changes; Cache
// API entries survive deploys.
export const SNIPPET_CACHE_PREFIX =
  "https://mise-versions.jdx.dev/__snippet-cache/v1/";

// Epoch seconds when the Worker last confirmed the repository is public (and
// allowed by GITHUB_MIRROR_ACCESS). The snippet serves an entry only within
// VISIBILITY_TTL_SECONDS of it, the same bound the Worker's own visibility
// cache gives, so a repo that turns private stops being served as quickly
// as it did without the snippet.
export const VERIFIED_AT_HEADER = "x-mise-mirror-verified-at";
// Epoch seconds when the cached content stops being fresh (the Worker's edge
// TTL for it). Refreshing the verification never extends this.
export const EXPIRES_AT_HEADER = "x-mise-mirror-expires-at";
// The Cache-Control the Worker means clients to see. The zone's Browser
// Cache TTL rewrites a lower max-age on Cache API hits, so the intended value
// is kept here and put back (see mirror.ts).
export const INTENDED_CACHE_CONTROL_HEADER = "x-mise-cache-control";
// Debug header: who answered, `snippet` or `worker`.
export const SOURCE_HEADER = "x-mise-mirror";

// Must equal VISIBILITY_TTL_SECONDS in web/src/lib/github/visibility.ts
// (checked by a test).
export const VISIBILITY_TTL_SECONDS = 60 * 60;
// Tolerated clock skew between the Worker that wrote an entry and the snippet.
const MAX_CLOCK_SKEW_SECONDS = 60;

const MIRROR_PREFIX = "/api/github/repos/";
const REPO = "[A-Za-z0-9_.-]+";
const ATTESTATION_PATH = new RegExp(
  `^${REPO}/${REPO}/attestations/[A-Za-z0-9_.-]+:[A-Fa-f0-9]+$`,
);
// Release tags (including `latest`), raw (possibly percent-encoded) as in
// the URL.
const RELEASE_PATH = new RegExp(
  `^${REPO}/${REPO}/releases/[A-Za-z0-9_.:@+%/-]+$`,
);
const RELEASE_LIST_PATH = new RegExp(`^${REPO}/${REPO}/releases$`);
// The only query the Worker's release-list handler honors: `page`, 1-10.
// Anything else (other params, repeats, non-canonical numbers) is not
// cached and goes to the Worker.
const RELEASE_LIST_QUERY = /^(?:\?page=([1-9]|10))?$/;

/**
 * The Cache API key for a mirror URL the snippet may answer, or null.
 * Attestations by digest and releases by tag (effectively immutable), plus
 * `releases/latest` and release-list pages (mutable; the Worker gives those
 * entries a short expiry). The host is dropped so mise-versions.jdx.dev and
 * mise-tools.jdx.dev share entries. Attestation and release handlers ignore
 * the query, so it is dropped; a release list keeps its normalized `page`.
 */
export function snippetCacheKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const { pathname } = parsed;
  if (!pathname.startsWith(MIRROR_PREFIX)) return null;
  const rest = pathname.slice(MIRROR_PREFIX.length);
  if (ATTESTATION_PATH.test(rest) || RELEASE_PATH.test(rest)) {
    return SNIPPET_CACHE_PREFIX + rest;
  }
  if (RELEASE_LIST_PATH.test(rest)) {
    const page = RELEASE_LIST_QUERY.exec(parsed.search);
    if (!page) return null;
    return `${SNIPPET_CACHE_PREFIX}${rest}?page=${page[1] ?? "1"}`;
  }
  return null;
}

/**
 * Whether a cached entry may be served at `nowSeconds` without asking the
 * Worker: its content is still fresh and its visibility check is recent.
 * Missing or unparsable metadata means no.
 */
export function servableEntry(response, nowSeconds) {
  if (!response || response.status !== 200) return false;
  const expiresAt = epochSeconds(response.headers.get(EXPIRES_AT_HEADER));
  const verifiedAt = epochSeconds(response.headers.get(VERIFIED_AT_HEADER));
  if (expiresAt === null || verifiedAt === null) return false;
  if (!response.headers.get(INTENDED_CACHE_CONTROL_HEADER)) return false;
  return (
    nowSeconds < expiresAt &&
    verifiedAt <= nowSeconds + MAX_CLOCK_SKEW_SECONDS &&
    nowSeconds - verifiedAt < VISIBILITY_TTL_SECONDS
  );
}

/** The client response for a cached entry, with the internal headers removed. */
export function clientResponse(cached, source) {
  const headers = new Headers(cached.headers);
  const intended = headers.get(INTENDED_CACHE_CONTROL_HEADER);
  if (intended) headers.set("Cache-Control", intended);
  headers.delete(INTENDED_CACHE_CONTROL_HEADER);
  headers.delete(VERIFIED_AT_HEADER);
  headers.delete(EXPIRES_AT_HEADER);
  headers.set(SOURCE_HEADER, source);
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers,
  });
}

function epochSeconds(value) {
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  return Number(value);
}

export default {
  async fetch(request) {
    if (request.method !== "GET") return fetch(request);
    const key = snippetCacheKey(request.url);
    if (!key) return fetch(request);
    let cached;
    try {
      cached = await caches.default.match(key);
    } catch {
      return fetch(request);
    }
    if (!servableEntry(cached, Date.now() / 1000)) return fetch(request);
    return clientResponse(cached, "snippet");
  },
};
