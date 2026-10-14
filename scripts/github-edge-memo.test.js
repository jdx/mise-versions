import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runMemoTest(source) {
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

// A Cache API stand-in for caches.default, and a KV stub that counts reads.
const PRELUDE = `
  import assert from "node:assert/strict";

  function fakeEdgeCache() {
    const store = new Map();
    const puts = [];
    return {
      store,
      puts,
      match: async (request) => {
        const entry = store.get(request.url);
        return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
      },
      put: async (request, response) => {
        const body = await response.text();
        const headers = Object.fromEntries(response.headers);
        puts.push({ url: request.url, body, headers });
        store.set(request.url, { body, headers });
      },
    };
  }

  function countingKv(initial = {}) {
    const store = new Map(Object.entries(initial));
    const reads = [];
    const writes = [];
    return {
      reads,
      writes,
      get: async (key, type) => {
        reads.push(key);
        const value = store.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      put: async (key, value, options) => {
        writes.push({ key, value, options });
        store.set(key, value);
      },
    };
  }

  const edge = fakeEdgeCache();
  globalThis.caches = { default: edge };
`;

test("memo entries expire with the value they copy", () => {
  runMemoTest(`${PRELUDE}
    const { readMemo, writeMemo, __testing } = await import(
      "./web/src/lib/github/edge-memo.ts"
    );
    const scope = {};
    const expiresAt = Date.now() + 90 * 1000;
    await writeMemo(scope, "github:visibility:o/r", true, expiresAt);

    assert.equal(edge.puts.length, 1);
    assert.equal(
      edge.puts[0].url,
      __testing.MEMO_URL_PREFIX + encodeURIComponent("github:visibility:o/r"),
    );
    const maxAge = Number(edge.puts[0].headers["cache-control"].match(/max-age=(\\d+)/)[1]);
    assert.ok(maxAge >= 89 && maxAge <= 90, String(maxAge));
    assert.deepEqual(await readMemo(scope, "github:visibility:o/r"), {
      value: true,
      expiresAt,
    });

    // Another isolate in the colo has no local entry but shares the Cache API.
    assert.deepEqual(await readMemo({}, "github:visibility:o/r"), {
      value: true,
      expiresAt,
    });

    // Past its expiry an entry is not served, even while the Cache API still
    // holds it.
    const realNow = Date.now;
    Date.now = () => expiresAt + 1;
    assert.equal(await readMemo(scope, "github:visibility:o/r"), undefined);
    assert.equal(await readMemo({}, "github:visibility:o/r"), undefined);
    Date.now = realNow;

    // Values with less than a second left are not memoized at all.
    await writeMemo(scope, "short", 1, Date.now() + 500);
    assert.equal(edge.puts.length, 1);
    assert.equal(await readMemo(scope, "short"), undefined);
  `);
});

test("memo works without the Cache API", () => {
  runMemoTest(`
    import assert from "node:assert/strict";
    const { readMemo, writeMemo } = await import(
      "./web/src/lib/github/edge-memo.ts"
    );
    assert.equal(typeof globalThis.caches, "undefined");
    const scope = {};
    await writeMemo(scope, "k", { a: 1 }, Date.now() + 60_000);
    assert.deepEqual((await readMemo(scope, "k")).value, { a: 1 });
    // Scopes do not share local entries.
    assert.equal(await readMemo({}, "k"), undefined);
  `);
});

test("read-through memo shares one load and does not memoize failures", () => {
  runMemoTest(`${PRELUDE}
    const { readThroughMemo } = await import("./web/src/lib/github/edge-memo.ts");
    const scope = {};
    let loads = 0;
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const load = async () => {
      loads++;
      await gate;
      return { value: "v", expiresAt: Date.now() + 60_000 };
    };
    const results = Promise.all([
      readThroughMemo(scope, "k", load),
      readThroughMemo(scope, "k", load),
    ]);
    release();
    assert.deepEqual(await results, ["v", "v"]);
    assert.equal(loads, 1);
    assert.equal(await readThroughMemo(scope, "k", load), "v");
    assert.equal(loads, 1);

    await assert.rejects(() =>
      readThroughMemo(scope, "bad", async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(
      await readThroughMemo(scope, "bad", async () => ({
        value: "ok",
        expiresAt: Date.now() + 60_000,
      })),
      "ok",
    );

    // An already-expired load is returned but not memoized.
    let expiredLoads = 0;
    const expired = async () => {
      expiredLoads++;
      return { value: null, expiresAt: 0 };
    };
    assert.equal(await readThroughMemo(scope, "gone", expired), null);
    assert.equal(await readThroughMemo(scope, "gone", expired), null);
    assert.equal(expiredLoads, 2);
  `);
});

test("visibility answers are served from the memo until the KV answer expires", () => {
  runMemoTest(`${PRELUDE}
    const { isPublicGitHubRepo } = await import("./web/src/lib/github/visibility.ts");
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response(JSON.stringify({ private: false, visibility: "public" }), {
        status: 200,
      });
    };

    const kv = countingKv();
    const env = { DB: {}, ANALYTICS_DB: {}, GITHUB_CACHE: kv };
    assert.equal(await isPublicGitHubRepo(env, "Owner", "Repo"), true);
    assert.equal(kv.reads.length, 1);
    assert.equal(kv.writes.length, 1);
    assert.equal(fetches, 1);

    // Same isolate, then another isolate in the colo: no KV reads.
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
    assert.equal(
      await isPublicGitHubRepo({ ...env, GITHUB_CACHE: { ...kv } }, "owner", "repo"),
      true,
    );
    assert.equal(kv.reads.length, 1);
    assert.equal(fetches, 1);

    // The memo expires an hour after the GitHub check, like the KV answer.
    const realNow = Date.now;
    Date.now = () => realNow() + 3600 * 1000 + 1;
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
    assert.equal(fetches, 2);
    Date.now = realNow;
  `);
});

test("a KV visibility answer is memoized only for what is left of its hour", () => {
  runMemoTest(`${PRELUDE}
    const { isPublicGitHubRepo } = await import("./web/src/lib/github/visibility.ts");
    globalThis.fetch = async () => {
      throw new Error("cached answer should not fetch");
    };
    const cachedAt = Date.now() - 3600 * 1000 + 120 * 1000;
    const kv = countingKv({
      "github:visibility:owner/repo": JSON.stringify({ cached_at: cachedAt, public: false }),
    });
    const env = { DB: {}, ANALYTICS_DB: {}, GITHUB_CACHE: kv };
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
    const stored = JSON.parse(edge.puts[0].body);
    assert.equal(stored.expires_at, cachedAt + 3600 * 1000);
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
    assert.equal(kv.reads.length, 1);
  `);
});

test("latest release generations are memoized briefly, absent ones included", () => {
  runMemoTest(`${PRELUDE}
    const {
      __testing,
      getGitHubLatestReleaseGenerations,
      rotateGitHubLatestReleaseGenerations,
    } = await import("./web/src/lib/github/release-generation.ts");
    assert.equal(__testing.GENERATION_MEMO_TTL_MS, 60 * 1000);

    const kv = countingKv();
    assert.equal(await getGitHubLatestReleaseGenerations(kv, "o", "r"), undefined);
    assert.equal(await getGitHubLatestReleaseGenerations(kv, "o", "r"), undefined);
    assert.equal(kv.reads.length, 1);

    // A rotation in this colo takes effect here at once.
    await rotateGitHubLatestReleaseGenerations(kv, [
      { versions: [{ release_url: "https://github.com/o/r/releases/tag/v1" }] },
    ]);
    const readsAfterRotate = kv.reads.length;
    const rotated = await getGitHubLatestReleaseGenerations(kv, "o", "r");
    assert.match(rotated.current, /^[0-9a-f]{64}$/);
    assert.equal(kv.reads.length, readsAfterRotate);

    // Elsewhere, a generation rotated behind the memo's back is picked up
    // once the memo expires.
    const other = countingKv();
    await getGitHubLatestReleaseGenerations(other, "x", "y");
    await rotateGitHubLatestReleaseGenerations(
      { ...other, put: other.put },
      [{ versions: [{ release_url: "https://github.com/x/y/releases/tag/v1" }] }],
    );
    assert.equal(await getGitHubLatestReleaseGenerations(other, "x", "y"), undefined);
    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 1000;
    const fresh = await getGitHubLatestReleaseGenerations(other, "x", "y");
    Date.now = realNow;
    assert.match(fresh.current, /^[0-9a-f]{64}$/);
  `);
});
