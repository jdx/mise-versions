import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";
import snippet, {
  EXPIRES_AT_HEADER,
  SNIPPET_CACHE_PREFIX,
  VERIFIED_AT_HEADER,
  VISIBILITY_TTL_SECONDS,
  snippetCacheKey,
} from "./github-mirror-cache.js";

const ORIGIN = "https://mise-versions.jdx.dev";
const ATTESTATION = "/api/github/repos/jdx/mise/attestations/sha256:abc123";
const RELEASE = "/api/github/repos/jdx/mise/releases/v2026.10.0";

// caches.default stand-in; `fetch` stands in for the Worker behind the
// snippet and records what it was handed.
function setup(entries = {}) {
  const store = new Map(Object.entries(entries));
  const matched = [];
  const passed = [];
  globalThis.caches = {
    default: {
      match: async (key) => {
        matched.push(String(key));
        const entry = store.get(String(key));
        return entry ? entry() : undefined;
      },
    },
  };
  globalThis.fetch = async (request) => {
    passed.push(request.url);
    return new Response("from worker", {
      headers: { "x-mise-mirror": "worker" },
    });
  };
  return { matched, passed };
}

function entry({
  verifiedAt = Math.floor(Date.now() / 1000) - 60,
  expiresAt = Math.floor(Date.now() / 1000) + 600,
  status = 200,
  extraHeaders = {},
} = {}) {
  return () =>
    new Response('{"tag_name":"v2026.10.0"}', {
      status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=7200, s-maxage=600",
        "X-Mise-Cache-Control": "public, max-age=600, s-maxage=3600",
        ...(verifiedAt === null
          ? {}
          : { [VERIFIED_AT_HEADER]: String(verifiedAt) }),
        ...(expiresAt === null
          ? {}
          : { [EXPIRES_AT_HEADER]: String(expiresAt) }),
        ...extraHeaders,
      },
    });
}

function get(path, { host = "mise-versions.jdx.dev", method = "GET" } = {}) {
  return snippet.fetch(new Request(`https://${host}${path}`, { method }));
}

test("cache keys cover attestations and exact-tag releases only", () => {
  assert.equal(
    snippetCacheKey(`${ORIGIN}${ATTESTATION}`),
    `${SNIPPET_CACHE_PREFIX}jdx/mise/attestations/sha256:abc123`,
  );
  // Host and query do not matter.
  assert.equal(
    snippetCacheKey(`https://mise-tools.jdx.dev${RELEASE}?per_page=1`),
    `${SNIPPET_CACHE_PREFIX}jdx/mise/releases/v2026.10.0`,
  );
  // Scoped and percent-encoded tags stay as they are in the URL.
  assert.equal(
    snippetCacheKey(
      `${ORIGIN}/api/github/repos/biomejs/biome/releases/%40biomejs%2Fbiome%402.5.0`,
    ),
    `${SNIPPET_CACHE_PREFIX}biomejs/biome/releases/%40biomejs%2Fbiome%402.5.0`,
  );
  for (const path of [
    "/api/github/repos/jdx/mise/releases/latest",
    "/api/github/repos/jdx/mise/releases/LATEST",
    "/api/github/repos/jdx/mise/releases",
    "/api/github/repos/jdx/mise/releases/",
    "/api/github/repos/jdx/mise/tags",
    "/api/github/repos/jdx/mise",
    "/api/github/repos/jdx/mise/contents/README.md",
    "/api/github/repos/jdx/mise/attestations/not-a-digest",
    "/api/github/repos/jd$x/mise/releases/v1",
    "/data/github/jdx/mise/releases.json",
  ]) {
    assert.equal(snippetCacheKey(`${ORIGIN}${path}`), null, path);
  }
});

test("a fresh, recently verified entry is served without the Worker", async () => {
  const key = snippetCacheKey(`${ORIGIN}${RELEASE}`);
  const { passed } = setup({ [key]: entry() });
  const response = await get(RELEASE, { host: "mise-tools.jdx.dev" });
  assert.deepEqual(passed, []);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"tag_name":"v2026.10.0"}');
  // The Worker's own client headers, minus the internal ones.
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=600, s-maxage=3600",
  );
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-mise-mirror"), "snippet");
  assert.equal(response.headers.get("x-mise-cache-control"), null);
  assert.equal(response.headers.get(VERIFIED_AT_HEADER), null);
  assert.equal(response.headers.get(EXPIRES_AT_HEADER), null);
});

test("attestations are served from the snippet too", async () => {
  const key = snippetCacheKey(`${ORIGIN}${ATTESTATION}`);
  const { passed } = setup({ [key]: entry() });
  const response = await get(ATTESTATION);
  assert.deepEqual(passed, []);
  assert.equal(response.headers.get("x-mise-mirror"), "snippet");
});

test("entries whose visibility check is too old go to the Worker", async () => {
  const key = snippetCacheKey(`${ORIGIN}${RELEASE}`);
  const now = Math.floor(Date.now() / 1000);
  const { passed } = setup({
    [key]: entry({ verifiedAt: now - VISIBILITY_TTL_SECONDS - 1 }),
  });
  const response = await get(RELEASE);
  assert.deepEqual(passed, [`${ORIGIN}${RELEASE}`]);
  assert.equal(response.headers.get("x-mise-mirror"), "worker");

  // Exactly at the limit is already too old.
  setup({ [key]: entry({ verifiedAt: now - VISIBILITY_TTL_SECONDS }) });
  assert.equal((await get(RELEASE)).headers.get("x-mise-mirror"), "worker");
});

test("missing, expired, unparsable and foreign entries go to the Worker", async () => {
  const key = snippetCacheKey(`${ORIGIN}${RELEASE}`);
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    missing: undefined,
    expired: entry({ expiresAt: now - 1 }),
    "no verification": entry({ verifiedAt: null }),
    "no expiry": entry({ expiresAt: null }),
    "unparsable verification": entry({
      extraHeaders: { [VERIFIED_AT_HEADER]: "soon" },
    }),
    "negative verification": entry({
      extraHeaders: { [VERIFIED_AT_HEADER]: "-5" },
    }),
    "verified in the future": entry({ verifiedAt: now + 3600 }),
    "not a 200": entry({ status: 404 }),
    // Written by something other than the Worker's snippet-cache writer.
    foreign: () =>
      new Response("{}", {
        headers: {
          "Cache-Control": "public, max-age=600",
          [VERIFIED_AT_HEADER]: String(now),
          [EXPIRES_AT_HEADER]: String(now + 600),
        },
      }),
  };
  for (const [name, cached] of Object.entries(cases)) {
    const { passed } = setup(cached ? { [key]: cached } : {});
    const response = await get(RELEASE);
    assert.deepEqual(passed, [`${ORIGIN}${RELEASE}`], name);
    assert.equal(response.headers.get("x-mise-mirror"), "worker", name);
  }
});

test("latest, lists and non-GET requests skip the cache entirely", async () => {
  for (const [path, method] of [
    ["/api/github/repos/jdx/mise/releases/latest", "GET"],
    ["/api/github/repos/jdx/mise/releases", "GET"],
    ["/api/github/repos/jdx/mise/tags", "GET"],
    [RELEASE, "HEAD"],
    [RELEASE, "POST"],
  ]) {
    const { matched, passed } = setup({
      [snippetCacheKey(`${ORIGIN}${RELEASE}`)]: entry(),
    });
    await get(path, { method });
    assert.deepEqual(matched, [], `${method} ${path}`);
    assert.equal(passed.length, 1, `${method} ${path}`);
  }
});

test("a failing cache lookup goes to the Worker", async () => {
  const { passed } = setup();
  globalThis.caches.default.match = async () => {
    throw new Error("cache unavailable");
  };
  await get(RELEASE);
  assert.equal(passed.length, 1);
});

test("the snippet fits the Snippets package limit and has no imports", () => {
  const file = new URL("./github-mirror-cache.js", import.meta.url);
  assert.ok(statSync(file).size < 32 * 1024);
  assert.doesNotMatch(readFileSync(file, "utf8"), /^\s*import\s/m);
});
