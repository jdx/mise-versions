import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runVersionsTest(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module"],
    {
      cwd: new URL("..", import.meta.url),
      input: PRELUDE + source,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

// A fake GitHub serving `releases` and `tags` (newest first) in pages of
// 100 with Link headers, a pool with one token, and an in-memory KV.
const PRELUDE = `
  import assert from "node:assert/strict";
  import {
    __testing,
    getCachedGitHubVersions,
    VersionsCrawlLimited,
  } from "./web/src/lib/github/versions.ts";
  import { githubStatus } from "./web/src/lib/github/mirror.ts";

  const HOUR = 60 * 60 * 1000;
  const MIN = 60 * 1000;

  function release(n, extra = {}) {
    return {
      tag_name: "v" + n,
      draft: false,
      prerelease: false,
      created_at: "2026-01-01T00:00:00Z",
      published_at: "2026-01-02T00:00:00Z",
      body: "dropped",
      assets: [{ name: "tool-" + n + ".tar.gz", browser_download_url: "b", url: "u" }],
      ...extra,
    };
  }
  function releases(count, from = count) {
    return Array.from({ length: count }, (_, i) => release(from - i));
  }

  const github = {
    releases: [],
    tags: [],
    calls: [],
    // page -> remaining failures to answer with before succeeding
    failures: {},
    failStatus: 504,
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    github.calls.push(url.pathname + url.search);
    if (url.pathname === "/graphql") {
      const { variables } = JSON.parse(init.body);
      const repository = {};
      for (const [key, sha] of Object.entries(variables)) {
        if (key.startsWith("c")) {
          repository[key] = { committedDate: "date-of-" + sha.slice(0, 4) };
        }
      }
      return new Response(JSON.stringify({ data: { repository } }), { status: 200 });
    }
    const kind = url.pathname.endsWith("/tags") ? "tags" : "releases";
    const page = Number(url.searchParams.get("page"));
    if (github.failures[page] > 0) {
      github.failures[page]--;
      return new Response("timeout", { status: github.failStatus });
    }
    const all = github[kind];
    const last = Math.max(1, Math.ceil(all.length / 100));
    const base = "https://api.github.com/repositories/1/" + kind + "?per_page=100&page=";
    const links = [];
    if (page < last) links.push("<" + base + (page + 1) + '>; rel="next"');
    if (page < last) links.push("<" + base + last + '>; rel="last"');
    return new Response(JSON.stringify(all.slice((page - 1) * 100, page * 100)), {
      status: 200,
      headers: links.length ? { link: links.join(", ") } : {},
    });
  };

  // drizzle's D1 driver reads rows through prepare().bind().raw().
  const poolDb = {
    prepare: (sql) => {
      const statement = {
        bind: () => statement,
        raw: async () =>
          sql.startsWith("select")
            ? [[7, "volunteer", null, null, "pool-token", null, "2026-01-01", null, 0, 1, null, null, null, null, null]]
            : [],
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      };
      return statement;
    },
  };

  function memoryKv(initial = {}) {
    const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
    const writes = [];
    return {
      store,
      writes,
      get: async (key, type) => {
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
  function storedEntry(kv, key) {
    return JSON.parse(kv.store.get(key));
  }
  function apiCalls() {
    return github.calls.splice(0);
  }
`;

test("a cold crawl reads every page and stores compact releases", () => {
  runVersionsTest(`
    github.releases = [
      release(250, { prerelease: true, published_at: null, created_at: "2026-03-01T00:00:00Z" }),
      release(249, { draft: true }),
      release(248, { assets: [] }),
      ...releases(247),
    ];
    const kv = memoryKv();
    const env = { DB: poolDb, GITHUB_CACHE: kv };
    const { versions, edgeSeconds, staleFallback } = await getCachedGitHubVersions(
      env, "Owner", "Repo", { source: "releases" },
    );
    assert.deepEqual(apiCalls().sort(), [
      "/repos/Owner/Repo/releases?per_page=100&page=1",
      "/repos/Owner/Repo/releases?per_page=100&page=2",
      "/repos/Owner/Repo/releases?per_page=100&page=3",
    ]);
    assert.equal(staleFallback, false);
    assert.equal(versions.source, "releases");
    assert.equal(versions.truncated, false);
    // Drafts are never published.
    assert.equal(versions.releases.length, 249);
    assert.deepEqual(versions.releases.slice(0, 3), [
      // No published_at: the date falls back to created_at, like mise's
      // GithubRelease::released_at().
      { tag: "v250", date: "2026-03-01T00:00:00Z", prerelease: true, asset_count: 1 },
      { tag: "v248", date: "2026-01-02T00:00:00Z", prerelease: false, asset_count: 0 },
      { tag: "v247", date: "2026-01-02T00:00:00Z", prerelease: false, asset_count: 1 },
    ]);
    assert.equal(versions.releases.at(-1).tag, "v1");
    assert.equal(kv.writes.length, 1);
    assert.equal(kv.writes[0].key, "github:versions:releases:owner/repo");
    assert.deepEqual(kv.writes[0].options, { expirationTtl: 30 * 24 * 60 * 60 });
    const entry = storedEntry(kv, "github:versions:releases:owner/repo");
    assert.equal(entry.head_at, entry.full_at);
    // Untracked: page 1 is re-read after 10 minutes, so the edge keeps it
    // that long.
    assert.equal(edgeSeconds, 600);
  `);
});

test("a crawl stops at the page cap and reports truncation", () => {
  runVersionsTest(`
    github.releases = releases(2550);
    const env = { DB: poolDb, GITHUB_CACHE: memoryKv() };
    const { versions } = await getCachedGitHubVersions(env, "o", "r", { source: "releases" });
    const calls = apiCalls();
    assert.equal(calls.length, 20);
    assert.ok(!calls.some((call) => call.endsWith("page=21")));
    assert.equal(versions.releases.length, 2000);
    assert.equal(versions.truncated, true);

    // Exactly 20 full pages is complete, not truncated.
    github.releases = releases(2000);
    const exact = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r", { source: "releases" },
    );
    assert.equal(exact.versions.releases.length, 2000);
    assert.equal(exact.versions.truncated, false);
  `);
});

test("a crawl keeps going when the list grows while it is read", () => {
  runVersionsTest(`
    const { crawl } = __testing;
    const page = (items, hasNextPage, lastPage = null) => ({ items, hasNextPage, lastPage, bytes: 1000 });
    const fetched = [];
    // GitHub said 2 pages, but a release was added: page 2 now links a third,
    // and its first entry repeats page 1's last.
    const result = await crawl(
      page([{ tag: "a" }, { tag: "b" }], true, 2),
      async (n) => {
        fetched.push(n);
        return n === 2 ? page([{ tag: "b" }, { tag: "c" }], true) : page([{ tag: "d" }], false);
      },
    );
    assert.deepEqual(fetched, [2, 3]);
    assert.deepEqual(result.items.map((item) => item.tag), ["a", "b", "c", "d"]);
    assert.equal(result.truncated, false);
  `);
});

test("crawls read big pages fewer at a time and stop when out of time", () => {
  runVersionsTest(`
    const { crawl } = __testing;
    const MB = 1024 * 1024;
    const page = (n, bytes) => ({ items: [{ tag: "p" + n }], hasNextPage: n < 13, lastPage: 13, bytes });
    async function maxInFlight(bytes) {
      let inFlight = 0;
      let max = 0;
      await crawl(page(1, bytes), async (n) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return page(n, bytes);
      });
      return max;
    }
    // cli/cli-sized pages (4 MB) go 6 at a time, uv-sized (8 MB) 3,
    // codex-sized (32 MB) one at a time.
    assert.equal(await maxInFlight(4 * MB), 6);
    assert.equal(await maxInFlight(8 * MB), 3);
    assert.equal(await maxInFlight(32 * MB), 1);

    // Out of time after page 1: keep the newest-first prefix, truncated.
    const fetched = [];
    const late = await crawl(page(1, MB), async (n) => {
      fetched.push(n);
      return page(n, MB);
    }, Date.now() - 21 * 1000);
    assert.deepEqual(fetched, []);
    assert.deepEqual(late.items, [{ tag: "p1" }]);
    assert.equal(late.truncated, true);

    // Page 1 took 12s: another 12s would overrun 20s, so stop now.
    const slow = await crawl(page(1, MB), async (n) => {
      fetched.push(n);
      return page(n, MB);
    }, Date.now() - 12 * 1000);
    assert.deepEqual(fetched, []);
    assert.equal(slow.truncated, true);
    // Page 1 took 5s: the next batch fits, and it was fast, so all do.
    const quick = await crawl(page(1, MB), async (n) => page(n, MB), Date.now() - 5 * 1000);
    assert.equal(quick.items.length, 13);
    assert.equal(quick.truncated, false);
  `);
});

test("fresh entries are served without reading GitHub", () => {
  runVersionsTest(`
    const now = Date.now();
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - 5 * MIN, full_at: now - HOUR, unchanged_since: now - HOUR,
        items: [{ tag: "v1", date: "d", prerelease: false, asset_count: 1 }],
        truncated: false,
      },
    });
    const { versions, edgeSeconds } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    assert.deepEqual(apiCalls(), []);
    assert.equal(versions.releases[0].tag, "v1");
    assert.deepEqual(kv.writes, []);
    // The edge keeps it only for the rest of its freshness.
    assert.ok(edgeSeconds > 290 && edgeSeconds <= 300, String(edgeSeconds));
  `);
});

test("a stale head re-reads page 1 only and merges it in front", () => {
  runVersionsTest(`
    const now = Date.now();
    // Stored when the repo had v1..v300; v301 and v302 were published since,
    // and v150 was deleted (it stays until the next full crawl).
    const stored = releases(300).map((r) => ({
      tag: r.tag_name, date: r.published_at, prerelease: false, asset_count: 1,
    }));
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - 11 * MIN, full_at: now - HOUR, unchanged_since: now - 2 * HOUR,
        items: stored, truncated: false,
      },
    });
    github.releases = releases(302).filter((r) => r.tag_name !== "v150");
    // v300 re-uploaded its assets.
    github.releases[2].assets = [];
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    assert.deepEqual(apiCalls(), ["/repos/o/r/releases?per_page=100&page=1"]);
    assert.equal(versions.releases.length, 302);
    assert.deepEqual(versions.releases.slice(0, 3).map((r) => [r.tag, r.asset_count]), [
      ["v302", 1], ["v301", 1], ["v300", 0],
    ]);
    assert.equal(versions.releases.at(-1).tag, "v1");
    const entry = storedEntry(kv, "github:versions:releases:o/r");
    assert.equal(entry.full_at, now - HOUR);
    assert.ok(entry.head_at >= now);
    // The list changed, so it has been unchanged since now.
    assert.ok(entry.unchanged_since >= now);
  `);
});

test("a head that shares nothing with the stored list triggers a full crawl", () => {
  runVersionsTest(`
    const now = Date.now();
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - 11 * MIN, full_at: now - HOUR, unchanged_since: now - HOUR,
        items: [{ tag: "old", date: "d", prerelease: false, asset_count: 1 }],
        truncated: false,
      },
    });
    github.releases = releases(150);
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    // Page 1 is read once and reused as the crawl's first page.
    assert.deepEqual(apiCalls(), [
      "/repos/o/r/releases?per_page=100&page=1",
      "/repos/o/r/releases?per_page=100&page=2",
    ]);
    assert.equal(versions.releases.length, 150);
    assert.ok(!versions.releases.some((r) => r.tag === "old"));
    assert.ok(storedEntry(kv, "github:versions:releases:o/r").full_at >= now);
  `);
});

test("releases re-crawl every 6 hours and tags every hour", () => {
  runVersionsTest(`
    const { refreshStep } = __testing;
    const now = Date.now();
    const entry = (fullAgo) => ({
      head_at: now - MIN, full_at: now - fullAgo, unchanged_since: now - MIN, items: [], truncated: false,
    });
    assert.equal(refreshStep(entry(5 * HOUR), now, "releases"), "fresh");
    assert.equal(refreshStep(entry(6 * HOUR), now, "releases"), "full");
    assert.equal(refreshStep(entry(50 * MIN), now, "tags"), "fresh");
    assert.equal(refreshStep(entry(HOUR), now, "tags"), "full");
    assert.equal(refreshStep(null, now, "tags"), "full");
  `);
});

test("tracked repos back off while unchanged and follow the release generation", () => {
  runVersionsTest(`
    const { refreshStep } = __testing;
    const now = Date.now();
    // Unchanged for 8h when page 1 was read 1h ago: fresh for 8h/4 = 2h.
    const quiet = {
      head_at: now - HOUR, full_at: now - HOUR, unchanged_since: now - 9 * HOUR,
      generation: "g1", items: [], truncated: false,
    };
    assert.equal(refreshStep(quiet, now, "releases", "g1"), "fresh");
    assert.equal(refreshStep({ ...quiet, head_at: now - 2 * HOUR }, now, "releases", "g1"), "head");
    // A published release rotates the generation: re-read page 1 right away.
    assert.equal(refreshStep(quiet, now, "releases", "g2"), "head");
    // Untracked repos never back off.
    const untracked = { ...quiet, generation: undefined };
    assert.equal(refreshStep(untracked, now, "releases"), "head");
    // The backoff is capped at 6h.
    const ancient = { ...quiet, head_at: now - 7 * HOUR, full_at: now - MIN, unchanged_since: now - 1000 * HOUR };
    assert.equal(refreshStep(ancient, now, "releases", "g1"), "head");
  `);
});

test("an unchanged head keeps unchanged_since and the generation is stored", () => {
  runVersionsTest(`
    const now = Date.now();
    github.releases = releases(3);
    const items = github.releases.map((r) => ({
      tag: r.tag_name, date: r.published_at, prerelease: false, asset_count: 1,
    }));
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - 3 * HOUR, full_at: now - HOUR, unchanged_since: now - 10 * HOUR,
        generation: "g1", items, truncated: false,
      },
    });
    const { edgeSeconds } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases", generation: "g2" },
    );
    const entry = storedEntry(kv, "github:versions:releases:o/r");
    assert.equal(entry.unchanged_since, now - 10 * HOUR);
    assert.equal(entry.generation, "g2");
    // Page 1 had no next page, so this was a full crawl too. Fresh for
    // 10h/4 = 2.5h, before the next full crawl in 6h.
    assert.ok(Math.abs(edgeSeconds - 2.5 * 3600) < 5, String(edgeSeconds));
  `);
});

test("asset filters keep only releases carrying that asset", () => {
  runVersionsTest(`
    github.releases = [
      release(3, { assets: [{ name: "packslip.sigstore.json" }, { name: "x" }] }),
      release(2),
      release(1, { assets: [{ name: "packslip.sigstore.json" }] }),
    ];
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r",
      { source: "releases", asset: "packslip.sigstore.json" },
    );
    assert.deepEqual(versions.releases, [
      { tag: "v3", date: "2026-01-02T00:00:00Z", prerelease: false, asset_count: 2 },
      { tag: "v1", date: "2026-01-02T00:00:00Z", prerelease: false, asset_count: 1 },
    ]);
    assert.equal(kv.writes[0].key, "github:versions:releases:o/r:asset:packslip.sigstore.json");
    // The stored list keeps every release, so page 1 can still be merged.
    assert.equal(storedEntry(kv, kv.writes[0].key).items.length, 3);
  `);
});

test("tags carry their commit dates", () => {
  runVersionsTest(`
    const sha = (n) => String(n).padStart(40, "0");
    github.tags = Array.from({ length: 120 }, (_, i) => ({
      name: "t" + (120 - i),
      commit: { sha: sha(120 - i), url: "u" },
    }));
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "tags" },
    );
    const calls = apiCalls();
    assert.equal(calls.filter((call) => call === "/graphql").length, 2);
    assert.equal(versions.source, "tags");
    assert.equal(versions.tags.length, 120);
    assert.deepEqual(versions.tags[0], { tag: "t120", sha: sha(120), date: "date-of-0000" });
    assert.equal(kv.writes[0].key, "github:versions:tags:o/r");
  `);
});

test("failed refreshes serve the stored list once, uncached at the edge", () => {
  runVersionsTest(`
    const now = Date.now();
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - HOUR, full_at: now - HOUR, unchanged_since: now - HOUR,
        items: [{ tag: "v1", date: "d", prerelease: false, asset_count: 1 }],
        truncated: false,
      },
    });
    github.failures = { 1: 2 };
    const result = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    assert.equal(result.staleFallback, true);
    assert.equal(result.edgeSeconds, 0);
    assert.equal(result.versions.releases[0].tag, "v1");
    assert.deepEqual(kv.writes, []);
  `);
});

test("a page GitHub times out on is retried once", () => {
  runVersionsTest(`
    github.releases = releases(250);
    github.failures = { 2: 1 };
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r", { source: "releases" },
    );
    assert.equal(versions.releases.length, 250);
    assert.equal(apiCalls().filter((call) => call.endsWith("page=2")).length, 2);

    // A 404 is an answer, not a timeout.
    github.failures = { 1: 1 };
    github.failStatus = 404;
    await assert.rejects(
      () => getCachedGitHubVersions({ DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r", { source: "releases" }),
      (error) => githubStatus(error) === 404,
    );
    assert.equal(apiCalls().length, 1);
  `);
});

test("with waitUntil, a due list is served at once and refreshed behind it", () => {
  runVersionsTest(`
    const now = Date.now();
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - HOUR, full_at: now - HOUR, unchanged_since: now - HOUR,
        items: [{ tag: "v1", date: "d", prerelease: false, asset_count: 1 }],
        truncated: false,
      },
    });
    github.releases = releases(2);
    const background = [];
    const result = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
      { waitUntil: (promise) => background.push(promise) },
    );
    assert.deepEqual(result.versions.releases.map((r) => r.tag), ["v1"]);
    assert.equal(result.staleFallback, false);
    // Kept at the edge for a minute, until the refresh has landed.
    assert.equal(result.edgeSeconds, 60);
    assert.equal(background.length, 1);
    await Promise.all(background);
    assert.deepEqual(
      storedEntry(kv, "github:versions:releases:o/r").items.map((r) => r.tag),
      ["v2", "v1"],
    );

    // A failed background refresh leaves the stored list alone.
    github.failures = { 1: 2 };
    kv.writes.length = 0;
    const entry = storedEntry(kv, "github:versions:releases:o/r");
    kv.store.set("github:versions:releases:o/r", JSON.stringify({ ...entry, head_at: now - HOUR }));
    await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
      { waitUntil: (promise) => background.push(promise) },
    );
    await Promise.all(background);
    assert.deepEqual(kv.writes, []);

    // A cold miss has nothing to serve, so it waits for the crawl.
    background.length = 0;
    const cold = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "other", { source: "releases" },
      { waitUntil: (promise) => background.push(promise) },
    );
    assert.equal(cold.versions.releases.length, 2);
    assert.equal(background.length, 0);
  `);
});

test("a later page GitHub cannot serve truncates the list instead of failing", () => {
  runVersionsTest(`
    github.releases = releases(450);
    // Page 3 fails twice (the retry too); pages 4-5 come back fine but come
    // after the gap, so they are dropped.
    github.failures = { 3: 2 };
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r", { source: "releases" },
    );
    assert.equal(versions.releases.length, 200);
    assert.equal(versions.releases.at(-1).tag, "v251");
    assert.equal(versions.truncated, true);

    // A rate limit is not a gap: the crawl fails so the token is marked.
    github.failures = { 2: 1 };
    github.failStatus = 429;
    await assert.rejects(
      () => getCachedGitHubVersions({ DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r", { source: "releases" }),
      (error) => githubStatus(error) === 429,
    );
  `);
});

test("cold crawls are rate-limited per client, refreshes are not", () => {
  runVersionsTest(`
    const keys = [];
    const limiter = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
    github.releases = releases(1);
    await assert.rejects(
      () => getCachedGitHubVersions(
        { DB: poolDb, GITHUB_CACHE: memoryKv(), GITHUB_VISIBILITY_LIMITER: limiter },
        "o", "r", { source: "releases", clientKey: "203.0.113.9" },
      ),
      (error) => error instanceof VersionsCrawlLimited,
    );
    assert.deepEqual(keys, ["versions:203.0.113.9"]);
    assert.deepEqual(apiCalls(), []);

    const now = Date.now();
    const kv = memoryKv({
      "github:versions:releases:o/r": {
        head_at: now - HOUR, full_at: now - HOUR, unchanged_since: now - HOUR,
        items: [], truncated: false,
      },
    });
    await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv, GITHUB_VISIBILITY_LIMITER: limiter },
      "o", "r", { source: "releases", clientKey: "203.0.113.9" },
    );
    assert.equal(keys.length, 1);
  `);
});
