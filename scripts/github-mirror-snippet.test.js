// Worker side of the GitHub-mirror snippet cache (snippets/github-mirror-cache.js):
// which responses get snippet-readable entries, the metadata on them, and how
// the Worker refreshes their visibility check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  SNIPPET_NAME,
  SNIPPET_RULE,
  upsertSnippetRule,
} from "./deploy-snippet.js";

function runSnippetTest(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module"],
    {
      cwd: new URL("..", import.meta.url),
      input: source,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

const PRELUDE = `
  import assert from "node:assert/strict";
  import snippet, {
    SNIPPET_CACHE_PREFIX,
  } from "./snippets/github-mirror-cache.js";
  import {
    gitHubMirrorReleaseSnippetCacheKey,
    gitHubMirrorSnippetCacheKey,
    matchGitHubMirrorSnippetCache,
    putGitHubMirrorSnippetCache,
    releaseEdgeCacheOptions,
  } from "./web/src/lib/github/mirror.ts";

  const store = new Map();
  const puts = [];
  globalThis.caches = {
    default: {
      match: async (key) => {
        const entry = store.get(String(key));
        return entry
          ? new Response(entry.body, { status: entry.status, headers: entry.headers })
          : undefined;
      },
      put: async (key, response) => {
        const body = await response.text();
        const headers = Object.fromEntries(response.headers);
        puts.push({ key: String(key), body, headers });
        store.set(String(key), { body, status: response.status, headers });
      },
    },
  };
  const workerCalls = [];
  globalThis.fetch = async (request) => {
    workerCalls.push(request.url);
    return new Response("from worker", { headers: { "x-mise-mirror": "worker" } });
  };

  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const RELEASE_URL =
    "https://mise-tools.jdx.dev/api/github/repos/jdx/mise/releases/v2026.1.0?x=1";
  const release = {
    tag_name: "v2026.1.0",
    immutable: true,
    published_at: "2026-01-01T00:00:00Z",
    assets: [{ name: "mise.tar.gz" }],
  };
  function workerResponse(status = 200) {
    return new Response(JSON.stringify(release), {
      status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=600, s-maxage=31536000, immutable",
        "x-mise-mirror": "worker",
      },
    });
  }
`;

test("the Worker and the snippet agree on the visibility window", () => {
  runSnippetTest(`
    import assert from "node:assert/strict";
    import { VISIBILITY_TTL_SECONDS as snippetTtl } from "./snippets/github-mirror-cache.js";
    import { VISIBILITY_TTL_SECONDS as workerTtl } from "./web/src/lib/github/visibility.ts";
    assert.equal(snippetTtl, workerTtl);
  `);
});

test("only exact-tag releases get a snippet-readable key", () => {
  runSnippetTest(`${PRELUDE}
    const request = new Request(RELEASE_URL);
    assert.equal(
      gitHubMirrorReleaseSnippetCacheKey(request, "v2026.1.0"),
      SNIPPET_CACHE_PREFIX + "jdx/mise/releases/v2026.1.0",
    );
    // A tag that decodes to latest, however it is spelled, stays with the Worker.
    const encodedLatest = new Request(
      "https://mise-versions.jdx.dev/api/github/repos/jdx/mise/releases/%6Catest",
    );
    assert.equal(gitHubMirrorReleaseSnippetCacheKey(encodedLatest, "latest"), null);
    assert.equal(
      gitHubMirrorSnippetCacheKey(
        new Request("https://mise-versions.jdx.dev/api/github/repos/jdx/mise/releases"),
      ),
      null,
    );
  `);
});

test("entries record content expiry and when visibility was confirmed", () => {
  runSnippetTest(`${PRELUDE}
    const request = new Request(RELEASE_URL);
    const key = gitHubMirrorReleaseSnippetCacheKey(request, "v2026.1.0");
    const verifiedAt = Date.now() - 20 * 60 * 1000;
    const options = releaseEdgeCacheOptions("v2026.1.0", release);
    await putGitHubMirrorSnippetCache(key, workerResponse(), options, verifiedAt);

    assert.equal(puts.length, 1);
    const { headers } = puts[0];
    assert.equal(puts[0].key, key);
    assert.equal(headers["x-mise-mirror-verified-at"], String(Math.floor(verifiedAt / 1000)));
    // Content expiry is the Worker's own edge TTL for this release (1 hour).
    const expiresAt = Number(headers["x-mise-mirror-expires-at"]);
    assert.ok(Math.abs(expiresAt - (nowSeconds() + 3600)) <= 1, String(expiresAt));
    assert.equal(headers["cache-control"], "public, max-age=3600, s-maxage=3600");
    // The Cache-Control clients get on a hit, as with the legacy edge entry.
    assert.equal(
      headers["x-mise-cache-control"],
      "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400",
    );
    assert.equal(headers["x-mise-mirror"], undefined);

    // The snippet serves it, with the same client headers a Worker hit gets.
    const fromSnippet = await snippet.fetch(new Request(RELEASE_URL));
    assert.deepEqual(workerCalls, []);
    assert.equal(fromSnippet.headers.get("x-mise-mirror"), "snippet");
    const fromWorker = await matchGitHubMirrorSnippetCache(key, verifiedAt, () => {});
    assert.equal(fromWorker.headers.get("x-mise-mirror"), "worker");
    const clientHeaders = (response) =>
      Object.fromEntries(
        [...response.headers].filter(([name]) => name !== "x-mise-mirror"),
      );
    assert.deepEqual(clientHeaders(fromSnippet), clientHeaders(fromWorker));
    assert.equal(await fromSnippet.text(), JSON.stringify(release));
    assert.equal(fromSnippet.headers.get("x-mise-mirror-verified-at"), null);
  `);
});

test("errors and uncacheable responses are never written", () => {
  runSnippetTest(`${PRELUDE}
    const key = gitHubMirrorReleaseSnippetCacheKey(new Request(RELEASE_URL), "v2026.1.0");
    for (const status of [404, 429, 502, 503]) {
      await putGitHubMirrorSnippetCache(key, workerResponse(status), {}, Date.now());
    }
    // An edge TTL of zero (never cached by the Worker) is not cached here either.
    await putGitHubMirrorSnippetCache(key, workerResponse(), { edgeMaxAge: 0 }, Date.now());
    assert.equal(puts.length, 0);
  `);
});

test("a Worker hit refreshes the verification but never the content expiry", () => {
  runSnippetTest(`${PRELUDE}
    const key = gitHubMirrorReleaseSnippetCacheKey(new Request(RELEASE_URL), "v2026.1.0");
    const oldCheck = Date.now() - 2 * 60 * 60 * 1000;
    await putGitHubMirrorSnippetCache(key, workerResponse(), {}, oldCheck);
    const expiresAt = puts[0].headers["x-mise-mirror-expires-at"];

    // Too old for the snippet: it passes the request to the Worker.
    await snippet.fetch(new Request(RELEASE_URL));
    assert.equal(workerCalls.length, 1);

    // The Worker re-checked visibility and serves its copy, rewriting the
    // entry's verification in the background.
    const pending = [];
    const newCheck = Date.now() - 5 * 1000;
    const served = await matchGitHubMirrorSnippetCache(key, newCheck, (p) => pending.push(p));
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("x-mise-mirror"), "worker");
    assert.equal(served.headers.get("cache-control"), "public, max-age=600, s-maxage=3600, stale-while-revalidate=86400");
    assert.equal(await served.text(), JSON.stringify(release));
    await Promise.all(pending);
    assert.equal(puts.length, 2);
    assert.equal(puts[1].headers["x-mise-mirror-verified-at"], String(Math.floor(newCheck / 1000)));
    assert.equal(puts[1].headers["x-mise-mirror-expires-at"], expiresAt);
    const ttl = Number(puts[1].headers["cache-control"].match(/s-maxage=(\\d+)/)[1]);
    assert.ok(ttl <= 3600 && ttl >= 3598, String(ttl));

    // Now the snippet answers again.
    const again = await snippet.fetch(new Request(RELEASE_URL));
    assert.equal(again.headers.get("x-mise-mirror"), "snippet");
    assert.equal(workerCalls.length, 1);

    // A hit verified no later than the entry is not rewritten.
    await matchGitHubMirrorSnippetCache(key, newCheck, (p) => pending.push(p));
    await Promise.all(pending);
    assert.equal(puts.length, 2);
  `);
});

test("the Worker ignores expired and foreign entries", () => {
  runSnippetTest(`${PRELUDE}
    const key = SNIPPET_CACHE_PREFIX + "jdx/mise/releases/v1";
    store.set(key, {
      body: "{}",
      status: 200,
      headers: { "x-mise-mirror-expires-at": String(nowSeconds() - 1) },
    });
    assert.equal(await matchGitHubMirrorSnippetCache(key, Date.now(), () => {}), null);
    store.set(key, { body: "{}", status: 200, headers: {} });
    assert.equal(await matchGitHubMirrorSnippetCache(key, Date.now(), () => {}), null);
    assert.equal(await matchGitHubMirrorSnippetCache(key + "x", Date.now(), () => {}), null);
  `);
});

test("access checks report when GitHub confirmed the repo public", () => {
  runSnippetTest(`
    import assert from "node:assert/strict";
    import { checkGitHubMirrorAccessVerified } from "./web/src/lib/github/visibility.ts";
    globalThis.caches = undefined;

    function kv(initial) {
      const store = new Map(Object.entries(initial));
      return {
        get: async (key, type) => {
          const value = store.get(key);
          return value === undefined ? null : type === "json" ? JSON.parse(value) : value;
        },
        put: async (key, value) => store.set(key, value),
      };
    }
    const checkedAt = Date.now() - 40 * 60 * 1000;
    const env = {
      DB: {},
      ANALYTICS_DB: {},
      GITHUB_CACHE: kv({
        "github:visibility:o/public": JSON.stringify({ cached_at: checkedAt, public: true }),
        "github:visibility:o/private": JSON.stringify({ cached_at: checkedAt, public: false }),
      }),
    };
    globalThis.fetch = async () => {
      throw new Error("GitHub should not be asked");
    };

    const allowed = await checkGitHubMirrorAccessVerified(env, "o", "public");
    assert.equal(allowed.denied, null);
    // The time of the GitHub answer, not of this request: the snippet's
    // window ends when the Worker's cached answer would.
    assert.equal(allowed.verifiedAt, checkedAt);
    // Memoized answers keep it.
    assert.equal(
      (await checkGitHubMirrorAccessVerified(env, "o", "public")).verifiedAt,
      checkedAt,
    );

    const hidden = await checkGitHubMirrorAccessVerified(env, "o", "private");
    assert.equal(hidden.denied.status, 404);
    assert.equal(hidden.verifiedAt, undefined);

    const off = await checkGitHubMirrorAccessVerified(
      { ...env, GITHUB_MIRROR_ACCESS: "off" },
      "o",
      "public",
    );
    assert.equal(off.denied.status, 403);
  `);
});

test("deploying replaces only this snippet's rule", () => {
  const existing = [
    {
      id: "a",
      snippet_name: "other",
      expression: 'http.host eq "jdx.dev"',
      description: "other",
      enabled: false,
      last_updated: "2026-01-01T00:00:00Z",
    },
    {
      snippet_name: SNIPPET_NAME,
      expression: "old",
      description: "old",
      enabled: true,
    },
  ];
  assert.deepEqual(upsertSnippetRule(existing, SNIPPET_RULE), [
    {
      snippet_name: "other",
      expression: 'http.host eq "jdx.dev"',
      description: "other",
      enabled: false,
    },
    SNIPPET_RULE,
  ]);
  assert.deepEqual(upsertSnippetRule(existing, null), [
    {
      snippet_name: "other",
      expression: 'http.host eq "jdx.dev"',
      description: "other",
      enabled: false,
    },
  ]);
  assert.deepEqual(upsertSnippetRule(null, SNIPPET_RULE), [SNIPPET_RULE]);
  assert.match(SNIPPET_RULE.expression, /mise-versions\.jdx\.dev/);
  assert.match(SNIPPET_RULE.expression, /mise-tools\.jdx\.dev/);
  assert.match(SNIPPET_RULE.expression, /\/releases\/latest/);
});
