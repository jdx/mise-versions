// Worker side of the GitHub-mirror snippet cache (snippets/github-mirror-cache.js):
// which responses get snippet-readable entries, the metadata on them, and how
// the Worker refreshes their visibility check.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  SNIPPET_NAME,
  SNIPPET_RULE,
  snippetUploadForm,
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

test("the Worker and the snippet agree on the visibility windows", () => {
  runSnippetTest(`
    import assert from "node:assert/strict";
    import {
      MAX_VISIBILITY_TTL_SECONDS as snippetMax,
      VISIBILITY_TTL_SECONDS as snippetTtl,
    } from "./snippets/github-mirror-cache.js";
    import {
      POPULAR_VISIBILITY_TTL_SECONDS as workerMax,
      VISIBILITY_TTL_SECONDS as workerTtl,
    } from "./web/src/lib/github/visibility.ts";
    // The default window for entries without a verified-until, and the cap
    // on it: the longest TTL the Worker gives any visibility answer.
    assert.equal(snippetTtl, workerTtl);
    assert.equal(snippetMax, workerMax);
  `);
});

test("only exact-tag releases use the long-lived snippet path", () => {
  runSnippetTest(`${PRELUDE}
    const request = new Request(RELEASE_URL);
    assert.equal(
      gitHubMirrorReleaseSnippetCacheKey(request, "v2026.1.0"),
      SNIPPET_CACHE_PREFIX + "jdx/mise/releases/v2026.1.0",
    );
    // A tag that decodes to latest, however it is spelled, gets the
    // short-lived copy instead.
    const encodedLatest = new Request(
      "https://mise-versions.jdx.dev/api/github/repos/jdx/mise/releases/%6Catest",
    );
    assert.equal(gitHubMirrorReleaseSnippetCacheKey(encodedLatest, "latest"), null);
    assert.equal(
      gitHubMirrorSnippetCacheKey(
        new Request("https://mise-versions.jdx.dev/api/github/repos/jdx/mise/releases?page=2"),
      ),
      SNIPPET_CACHE_PREFIX + "jdx/mise/releases?page=2",
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

test("entries carry the access grant's end, and the snippet honors it", () => {
  runSnippetTest(`${PRELUDE}
    const key = gitHubMirrorReleaseSnippetCacheKey(new Request(RELEASE_URL), "v2026.1.0");
    // A popular repo: GitHub confirmed it public 5 hours ago, trusted for a
    // day, but the access check only grants the next hour.
    const checkedAt = Date.now() - 5 * 60 * 60 * 1000;
    const until = Date.now() + 60 * 60 * 1000;
    await putGitHubMirrorSnippetCache(key, workerResponse(), {}, checkedAt, until);
    assert.equal(puts[0].headers["x-mise-mirror-verified-until"], String(Math.floor(until / 1000)));
    const hit = await snippet.fetch(new Request(RELEASE_URL));
    assert.equal(hit.headers.get("x-mise-mirror"), "snippet");
    assert.equal(hit.headers.get("x-mise-mirror-verified-until"), null);
    assert.deepEqual(workerCalls, []);

    // A Worker hit whose grant runs only a little longer does not rewrite it.
    const pending = [];
    const served = await matchGitHubMirrorSnippetCache(
      key, checkedAt, (p) => pending.push(p), until + 10 * 60 * 1000,
    );
    assert.equal(served.headers.get("x-mise-mirror-verified-until"), null);
    await Promise.all(pending);
    assert.equal(puts.length, 1);
    // One that runs well past it does, with the same GitHub check time.
    const later = until + 45 * 60 * 1000;
    await matchGitHubMirrorSnippetCache(key, checkedAt, (p) => pending.push(p), later);
    await Promise.all(pending);
    assert.equal(puts.length, 2);
    assert.equal(puts[1].headers["x-mise-mirror-verified-until"], String(Math.floor(later / 1000)));
    assert.equal(puts[1].headers["x-mise-mirror-verified-at"], String(Math.floor(checkedAt / 1000)));

    // Without an explicit end, an entry gets the default hour after the check.
    puts.length = 0;
    await putGitHubMirrorSnippetCache(key, workerResponse(), {}, checkedAt);
    assert.equal(
      puts[0].headers["x-mise-mirror-verified-until"],
      String(Math.floor((checkedAt + 3600 * 1000) / 1000)),
    );
    await snippet.fetch(new Request(RELEASE_URL));
    assert.equal(workerCalls.length, 1);
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

    // Not popular: the grant ends an hour after the GitHub check.
    assert.equal(allowed.verifiedUntil, checkedAt + 3600 * 1000);

    // Popular (a day's TTL), checked 5 hours ago: the grant ends at most an
    // hour from now, so GITHUB_MIRROR_ACCESS still applies hourly.
    const popularAt = Date.now() - 5 * 60 * 60 * 1000;
    await env.GITHUB_CACHE.put(
      "github:visibility:o/popular",
      JSON.stringify({ cached_at: popularAt, public: true, ttl: 86400 }),
    );
    const before = Date.now();
    const popular = await checkGitHubMirrorAccessVerified(env, "o", "popular");
    assert.equal(popular.denied, null);
    assert.equal(popular.verifiedAt, popularAt);
    assert.ok(popular.verifiedUntil >= before + 3600 * 1000);
    assert.ok(popular.verifiedUntil <= Date.now() + 3600 * 1000);

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
  assert.match(SNIPPET_RULE.expression, /contains "\/releases\/"/);
  assert.match(
    SNIPPET_RULE.expression,
    /ends_with\(http\.request\.uri\.path, "\/releases"\)/,
  );
});

// Mutable endpoints: `releases/latest` and release-list pages get a short-lived
// snippet copy next to the Worker's generation-keyed entry.

test("the mutable snippet TTL defaults to five minutes and is capped at an hour", () => {
  runSnippetTest(`
    import assert from "node:assert/strict";
    import { mutableSnippetTtlSeconds } from "./web/src/lib/github/mirror.ts";
    assert.equal(mutableSnippetTtlSeconds(undefined), 300);
    assert.equal(mutableSnippetTtlSeconds(""), 300);
    assert.equal(mutableSnippetTtlSeconds("nope"), 300);
    assert.equal(mutableSnippetTtlSeconds("-1"), 300);
    assert.equal(mutableSnippetTtlSeconds("120"), 120);
    assert.equal(mutableSnippetTtlSeconds("0"), 0);
    assert.equal(mutableSnippetTtlSeconds("86400"), 3600);
  `);
});

// Runs a release route handler with cloudflare:workers stubbed, against an
// in-memory KV (repo already verified public), a fake caches.default, and a
// fake GitHub.
const ROUTE_PRELUDE = `
  import assert from "node:assert/strict";
  import { register } from "node:module";
  register(
    "data:text/javascript," +
      encodeURIComponent(\`
        export async function resolve(specifier, context, next) {
          if (specifier === "cloudflare:workers") {
            return {
              url: "data:text/javascript,export const env = globalThis.__routeEnv;",
              shortCircuit: true,
            };
          }
          return next(specifier, context);
        }
      \`),
  );
  import snippet from "./snippets/github-mirror-cache.js";

  const store = new Map();
  const puts = [];
  globalThis.caches = {
    default: {
      match: async (key) => {
        const url = typeof key === "string" ? key : key.url;
        const entry = store.get(url);
        return entry
          ? new Response(entry.body, { status: 200, headers: entry.headers })
          : undefined;
      },
      put: async (key, response) => {
        const url = typeof key === "string" ? key : key.url;
        const body = await response.text();
        const headers = Object.fromEntries(response.headers);
        puts.push({ url, body, headers });
        store.set(url, { body, headers });
      },
    },
  };
  const verifiedAt = Date.now() - 10 * 60 * 1000;
  const kvData = new Map([
    ["github:visibility:o/r", JSON.stringify({ cached_at: verifiedAt, public: true })],
  ]);
  globalThis.__routeEnv = {
    DB: {},
    ANALYTICS_DB: {},
    GITHUB_MIRROR_ACCESS: "public",
    GITHUB_CACHE: {
      get: async (key, type) => {
        const value = kvData.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      put: async (key, value) => kvData.set(key, value),
      delete: async (key) => kvData.delete(key),
    },
  };
  const pending = [];
  async function call(route, url, params) {
    const response = await route.GET({
      params,
      request: new Request(url),
      locals: { cfContext: { waitUntil: (p) => pending.push(p) } },
    });
    await Promise.all(pending.splice(0));
    return response;
  }
  const snippetPuts = () =>
    puts.filter(({ url }) => url.includes("/__snippet-cache/"));
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const listRoute = await import(
    "./web/src/pages/api/github/repos/[owner]/[repo]/releases/index.ts"
  );
  const releaseRoute = await import(
    "./web/src/pages/api/github/repos/[owner]/[repo]/releases/[...tag].ts"
  );
`;

test("fresh latest and list answers get a short-lived snippet copy", () => {
  runSnippetTest(`${ROUTE_PRELUDE}
    globalThis.fetch = async (url) => {
      url = String(url);
      if (url.includes("/releases/latest")) {
        return new Response(JSON.stringify({
          tag_name: "v2.0.0", draft: false, prerelease: false,
          created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z",
          assets: [{ name: "a.tar.gz" }],
        }));
      }
      return new Response(JSON.stringify([{ tag_name: "v2.0.0", draft: false, assets: [] }]));
    };

    const latestUrl = "https://mise-tools.jdx.dev/api/github/repos/o/r/releases/latest";
    const latest = await call(releaseRoute, latestUrl, { owner: "o", repo: "r", tag: "latest" });
    assert.equal(latest.status, 200);
    assert.equal(latest.headers.get("x-mise-mirror"), "worker");
    let [copy] = snippetPuts();
    assert.equal(copy.url, "https://mise-versions.jdx.dev/__snippet-cache/v1/o/r/releases/latest");
    // Untracked latest: the Worker keeps it 10 minutes, the snippet 5.
    assert.ok(Math.abs(Number(copy.headers["x-mise-mirror-expires-at"]) - (nowSeconds() + 300)) <= 1);
    assert.equal(copy.headers["x-mise-mirror-verified-at"], String(Math.floor(verifiedAt / 1000)));
    assert.equal(copy.headers["x-mise-cache-control"], "public, max-age=0, s-maxage=600");

    // The snippet now answers latest, with the Worker's hit headers.
    const workerCalls = [];
    globalThis.fetch = async (request) => {
      workerCalls.push(request.url);
      return new Response("worker");
    };
    const served = await snippet.fetch(new Request(latestUrl));
    assert.deepEqual(workerCalls, []);
    assert.equal(served.headers.get("x-mise-mirror"), "snippet");
    assert.equal(served.headers.get("cache-control"), "public, max-age=0, s-maxage=600");
    assert.equal(JSON.parse(await served.text()).tag_name, "v2.0.0");

    // Release lists: the key carries the normalized page.
    globalThis.fetch = async () =>
      new Response(JSON.stringify([{ tag_name: "v2.0.0", draft: false, assets: [] }]));
    const list = await call(
      listRoute,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=2",
      { owner: "o", repo: "r" },
    );
    assert.equal(list.status, 200);
    copy = snippetPuts().at(-1);
    assert.equal(copy.url, "https://mise-versions.jdx.dev/__snippet-cache/v1/o/r/releases?page=2");
    assert.ok(Math.abs(Number(copy.headers["x-mise-mirror-expires-at"]) - (nowSeconds() + 300)) <= 1);

    // A query the snippet would not cache gets no copy, though the Worker
    // still answers (and caches) it.
    const before = snippetPuts().length;
    const extra = await call(
      listRoute,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=3&per_page=100",
      { owner: "o", repo: "r" },
    );
    assert.equal(extra.status, 200);
    assert.equal(snippetPuts().length, before);

    // GITHUB_MIRROR_SNIPPET_TTL_SECONDS=0 turns the copies off.
    globalThis.__routeEnv.GITHUB_MIRROR_SNIPPET_TTL_SECONDS = "0";
    await call(
      listRoute,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=4",
      { owner: "o", repo: "r" },
    );
    assert.equal(snippetPuts().length, before);
  `);
});

test("a Worker cache hit refreshes the snippet copy without outliving its entry", () => {
  runSnippetTest(`${ROUTE_PRELUDE}
    let upstream = 0;
    globalThis.fetch = async () => {
      upstream++;
      return new Response(JSON.stringify([{ tag_name: "v2.0.0", draft: false, assets: [] }]));
    };
    const url = "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=2";
    const key = "https://mise-versions.jdx.dev/__snippet-cache/v1/o/r/releases?page=2";
    await call(listRoute, url, { owner: "o", repo: "r" });
    assert.equal(upstream, 1);
    // The snippet copy expired; the Worker's own entry has 90 seconds left.
    store.delete(key);
    for (const [entryUrl, entry] of store) {
      if (entryUrl.includes("/releases?page=2")) {
        entry.headers["x-mise-mirror-expires-at"] = String(nowSeconds() + 90);
      }
    }
    const hit = await call(listRoute, url, { owner: "o", repo: "r" });
    assert.equal(upstream, 1);
    assert.equal(hit.headers.get("x-mise-mirror"), "worker");
    // Internal headers never reach clients.
    assert.equal(hit.headers.get("x-mise-mirror-expires-at"), null);
    assert.equal(hit.headers.get("x-mise-cache-control"), null);
    const copy = store.get(key);
    assert.ok(copy, "copied from the Worker's hit");
    assert.equal(copy.headers["x-mise-mirror-expires-at"], String(nowSeconds() + 90));

    // A still-servable copy is not rewritten on every Worker request.
    const count = puts.length;
    await call(listRoute, url, { owner: "o", repo: "r" });
    assert.equal(puts.length, count);

    // Worker entries written before expiry was recorded are not copied.
    store.delete(key);
    for (const [entryUrl, entry] of store) {
      if (entryUrl.includes("/releases?page=2")) {
        delete entry.headers["x-mise-mirror-expires-at"];
      }
    }
    await call(listRoute, url, { owner: "o", repo: "r" });
    assert.equal(store.get(key), undefined);
  `);
});

test("stale fallbacks are never copied for the snippet", () => {
  runSnippetTest(`${ROUTE_PRELUDE}
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    kvData.set("github:releases:o/r:2", JSON.stringify({
      cached_at: old,
      data: { releases: [{ tag_name: "v1.0.0" }], next_page: null },
    }));
    kvData.set("github:release:o/r:latest", JSON.stringify({
      cached_at: old,
      data: {
        tag_name: "v1.0.0", draft: false, prerelease: false,
        created_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z",
        assets: [{ name: "a.tar.gz" }],
      },
    }));
    globalThis.fetch = async () => {
      throw new Error("GitHub unavailable");
    };

    const list = await call(
      listRoute,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=2",
      { owner: "o", repo: "r" },
    );
    assert.equal(list.status, 200);
    assert.equal(list.headers.get("cache-control"), "public, max-age=0, s-maxage=0");

    const latest = await call(
      releaseRoute,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases/latest",
      { owner: "o", repo: "r", tag: "latest" },
    );
    assert.equal(latest.status, 200);
    assert.equal(JSON.parse(await latest.text()).tag_name, "v1.0.0");
    assert.equal(latest.headers.get("cache-control"), "public, max-age=0, s-maxage=0");

    // Neither the snippet copy nor the Worker's own edge entry.
    assert.deepEqual(
      puts.map(({ url }) => url).filter((url) => !url.includes("/__mise/kv-memo/")),
      [],
    );
  `);
});

test("the snippet upload names the module part after its file", async () => {
  const form = snippetUploadForm(
    "export default {};",
    "github-mirror-cache.js",
  );
  assert.deepEqual([...form.keys()], ["metadata", "github-mirror-cache.js"]);
  assert.deepEqual(JSON.parse(form.get("metadata")), {
    main_module: "github-mirror-cache.js",
  });
  const file = form.get("github-mirror-cache.js");
  assert.equal(file.name, "github-mirror-cache.js");
  assert.equal(file.type, "application/javascript+module");
  assert.equal(await file.text(), "export default {};");
  assert.equal(form.get("files"), null);

  // Serialized, the part carries name= and filename= set to the file name.
  const body = await new Response(form).text();
  assert.match(
    body,
    /Content-Disposition: form-data; name="github-mirror-cache\.js"; filename="github-mirror-cache\.js"\r\nContent-Type: application\/javascript\+module/,
  );
});
