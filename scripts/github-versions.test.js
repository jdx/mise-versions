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
    bakeVersionsPage,
    getCachedGitHubVersions,
    parseVersionsPath,
    recordVersionsDemand,
    versionsPath,
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
      list: async ({ prefix = "", cursor, limit = 1000 }) => {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + limit);
        const done = start + limit >= keys.length;
        return {
          keys: page.map((name) => ({ name })),
          list_complete: done,
          cursor: done ? undefined : String(start + limit),
        };
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
    // Page 1 is read again at the end to check the pages join up.
    assert.deepEqual(apiCalls().sort(), [
      "/repos/Owner/Repo/releases?per_page=100&page=1",
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
    // 20 pages, plus page 1 again to check the pages join up.
    assert.equal(calls.length, 21);
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
        head_at: now - 5 * MIN, full_at: now - HOUR, unchanged_since: now - 5 * MIN,
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
        head_at: now - 11 * MIN, full_at: now - HOUR, unchanged_since: now - 11 * MIN,
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
        head_at: now - 11 * MIN, full_at: now - HOUR, unchanged_since: now - 11 * MIN,
        items: [{ tag: "old", date: "d", prerelease: false, asset_count: 1 }],
        truncated: false,
      },
    });
    github.releases = releases(150);
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    // Page 1 is reused as the crawl's first page, then read again to check
    // the pages join up.
    assert.deepEqual(apiCalls(), [
      "/repos/o/r/releases?per_page=100&page=1",
      "/repos/o/r/releases?per_page=100&page=2",
      "/repos/o/r/releases?per_page=100&page=1",
    ]);
    assert.equal(versions.releases.length, 150);
    assert.ok(!versions.releases.some((r) => r.tag === "old"));
    assert.ok(storedEntry(kv, "github:versions:releases:o/r").full_at >= now);
  `);
});

test("lists are re-crawled in full every 6 hours", () => {
  runVersionsTest(`
    const { refreshStep } = __testing;
    const now = Date.now();
    const entry = (fullAgo) => ({
      head_at: now - MIN, full_at: now - fullAgo, unchanged_since: now - MIN, items: [], truncated: false,
    });
    for (const source of ["releases", "tags"]) {
      assert.equal(refreshStep(entry(5 * HOUR), now, source), "fresh");
      assert.equal(refreshStep(entry(6 * HOUR), now, source), "full");
      assert.equal(refreshStep(null, now, source), "full");
    }
  `);
});

test("page 1 backs off while unchanged and follows the release generation", () => {
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
    // Untracked repos back off the same way; tag lists ignore generations.
    assert.equal(refreshStep({ ...quiet, generation: undefined }, now, "releases"), "fresh");
    assert.equal(refreshStep(quiet, now, "tags"), "fresh");
    // A list that just changed is re-read every 10 minutes (every build).
    const active = { ...quiet, head_at: now - 11 * MIN, unchanged_since: now - 11 * MIN };
    assert.equal(refreshStep(active, now, "releases", "g1"), "head");
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
    // Fresh for 10h/4 = 2.5h, but the Worker keeps its answers at the edge
    // for at most 10 minutes: the next deploy bakes the file.
    assert.equal(edgeSeconds, 600);
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
    // One query per page, and one for page 1 read again at the end.
    assert.equal(calls.filter((call) => call === "/graphql").length, 3);
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

test("list paths are lowercase and map to one list each", () => {
  runVersionsTest(`
    assert.equal(versionsPath({ owner: "Cli", repo: "CLI", source: "releases" }), "github/cli/cli/releases.json");
    assert.equal(versionsPath({ owner: "apache", repo: "tomcat", source: "tags" }), "github/apache/tomcat/tags.json");
    assert.equal(
      versionsPath({ owner: "jdx", repo: "mise", source: "releases", asset: "packslip.sigstore.json" }),
      "github/jdx/mise/assets/packslip.sigstore.json/releases.json",
    );
    assert.deepEqual(parseVersionsPath("/data/github/cli/cli/releases.json?x=1"), {
      owner: "cli", repo: "cli", source: "releases", asset: undefined,
    });
    assert.deepEqual(parseVersionsPath("/data/github/jdx/mise/assets/packslip.sigstore.json/releases.json"), {
      owner: "jdx", repo: "mise", source: "releases", asset: "packslip.sigstore.json",
    });
    assert.equal(parseVersionsPath("/data/github/apache/tomcat/tags.json").source, "tags");
    for (const bad of [
      "/data/github/Cli/cli/releases.json",
      "/data/github/../x/releases.json",
      "/data/github/o/r/assets/a b/releases.json",
      "/data/github/o/r/assets/x/tags.json",
      "/data/github/o/r/other.json",
      "/data/github/o/releases.json",
    ]) {
      assert.equal(parseVersionsPath(bad), null, bad);
    }
  `);
});

test("responses carry fetched_at, and Worker requests count as demand", () => {
  runVersionsTest(`
    github.releases = releases(1);
    const kv = memoryKv();
    const env = { DB: poolDb, GITHUB_CACHE: kv };
    const background = [];
    const waitUntil = (promise) => background.push(promise);
    const demandKey = "github:versions-demand:releases:o/r";
    const cold = await getCachedGitHubVersions(env, "o", "r", { source: "releases", demand: true }, { waitUntil });
    await Promise.all(background);
    assert.match(cold.versions.fetched_at, /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/);
    // Demand is its own key, so stamping it never rewrites the list.
    const firstStamp = storedEntry(kv, demandKey).requested_at;
    assert.ok(Date.now() - firstStamp < 5000);
    assert.equal(storedEntry(kv, "github:versions:releases:o/r").requested_at, undefined);
    const demandWrite = kv.writes.find((w) => w.key === demandKey);
    assert.deepEqual(demandWrite.options, { expirationTtl: 35 * 24 * 60 * 60 });

    // Within a day: no rewrite.
    kv.writes.length = 0;
    await getCachedGitHubVersions(env, "o", "r", { source: "releases", demand: true }, { waitUntil });
    await Promise.all(background);
    assert.deepEqual(kv.writes, []);

    // A day later: only the demand key is written.
    kv.store.set(demandKey, JSON.stringify({ requested_at: firstStamp - 25 * HOUR }));
    await getCachedGitHubVersions(env, "o", "r", { source: "releases", demand: true }, { waitUntil });
    await Promise.all(background);
    assert.deepEqual(kv.writes.map((w) => w.key), [demandKey]);
    assert.ok(storedEntry(kv, demandKey).requested_at >= firstStamp);
    assert.deepEqual(apiCalls(), ["/repos/o/r/releases?per_page=100&page=1"]);
  `);
});

// Lists in KV, each with its demand and freshness, plus visibility answers.
const BAKE_SETUP = `
  const now = Date.now();
  const item = (tag) => ({ tag, date: "d", prerelease: false, asset_count: 1 });
  const entry = (extra) => ({
    head_at: now - MIN, full_at: now - MIN, unchanged_since: now - MIN,
    items: [item("v1")], truncated: false, ...extra,
  });
  const demand = (key, ago = HOUR) => ({
    ["github:versions-demand:" + key]: { requested_at: now - ago },
  });
  const visibility = (isPublic) => ({ cached_at: now, public: isPublic });
  const kv = memoryKv({
    "github:versions:releases:fresh/repo": entry(),
    "github:versions:releases:due/repo": entry({ head_at: now - HOUR, unchanged_since: now - HOUR }),
    "github:versions:tags:fresh/repo": entry({ items: [{ tag: "t1", sha: "a".repeat(40), date: "d" }] }),
    "github:versions:releases:fresh/repo:asset:packslip.sigstore.json": entry({
      items: [{ ...item("v2"), has_asset: true }, { ...item("v1"), has_asset: false }],
    }),
    "github:versions:releases:quiet/repo": entry(),
    "github:versions:releases:secret/repo": entry(),
    ...demand("releases:fresh/repo"),
    ...demand("releases:due/repo"),
    ...demand("tags:fresh/repo"),
    ...demand("releases:fresh/repo:asset:packslip.sigstore.json"),
    ...demand("releases:quiet/repo", 31 * 24 * HOUR),
    ...demand("releases:secret/repo"),
    "github:visibility:fresh/repo": visibility(true),
    "github:visibility:due/repo": visibility(true),
    "github:visibility:quiet/repo": visibility(true),
    "github:visibility:secret/repo": visibility(false),
  });
  github.releases = releases(2);
`;

test("a bake page exports demanded, servable lists and refreshes the due ones", () => {
  runVersionsTest(`
    ${BAKE_SETUP}
    const page = await bakeVersionsPage(
      { DB: poolDb, GITHUB_CACHE: kv, ANALYTICS_DB: {} },
      { limit: 100, refreshUntil: Date.now() + 60_000 },
    );
    assert.equal(page.cursor, null);
    assert.deepEqual(page.stats, {
      listed: 6, unrequested: 1, denied: 1, refreshed: 1, deferred: 0, failed: 0,
    });
    const files = Object.fromEntries(page.files.map((f) => [f.path, JSON.parse(f.body)]));
    assert.deepEqual(Object.keys(files).sort(), [
      "github/due/repo/releases.json",
      "github/fresh/repo/assets/packslip.sigstore.json/releases.json",
      "github/fresh/repo/releases.json",
      "github/fresh/repo/tags.json",
    ]);
    // Only the due list went to GitHub, and it is baked as refreshed.
    assert.deepEqual(apiCalls(), ["/repos/due/repo/releases?per_page=100&page=1"]);
    assert.deepEqual(files["github/due/repo/releases.json"].releases.map((r) => r.tag), ["v2", "v1"]);
    // The asset list keeps only releases carrying the asset, without the flag.
    assert.deepEqual(files["github/fresh/repo/assets/packslip.sigstore.json/releases.json"].releases, [item("v2")]);
    assert.equal(files["github/fresh/repo/tags.json"].source, "tags");
    assert.ok(page.files.every((f) => f.requested_at === now - HOUR));
    // The refresh left the demand stamp alone.
    assert.equal(storedEntry(kv, "github:versions-demand:releases:due/repo").requested_at, now - HOUR);
  `);
});

test("a bake bakes due lists as stored when out of time or tokens", () => {
  runVersionsTest(`
    ${BAKE_SETUP}
    const late = await bakeVersionsPage(
      { DB: poolDb, GITHUB_CACHE: kv, ANALYTICS_DB: {} },
      { refreshUntil: 0 },
    );
    assert.equal(late.stats.deferred, 1);
    assert.equal(late.files.length, 4);
    assert.deepEqual(apiCalls(), []);

    // No D1, so no pool token: never fall back to anonymous requests.
    const empty = await bakeVersionsPage(
      { DB: {}, GITHUB_CACHE: kv, ANALYTICS_DB: {} },
      { refreshUntil: Date.now() + 60_000 },
    );
    assert.equal(empty.outOfTokens, true);
    assert.equal(empty.stats.deferred, 1);
    assert.equal(empty.files.length, 4);
    assert.deepEqual(apiCalls(), []);
  `);
});

test("a bake pages the KV listing and honours a disabled mirror", () => {
  runVersionsTest(`
    ${BAKE_SETUP}
    const env = { DB: poolDb, GITHUB_CACHE: kv, ANALYTICS_DB: {} };
    const first = await bakeVersionsPage(env, { limit: 4 });
    assert.equal(first.stats.listed, 4);
    assert.equal(first.cursor, "4");
    const second = await bakeVersionsPage(env, { limit: 4, cursor: first.cursor });
    assert.equal(second.stats.listed, 2);
    assert.equal(second.cursor, null);

    const off = await bakeVersionsPage({ ...env, GITHUB_MIRROR_ACCESS: "off" }, {});
    assert.equal(off.files.length, 0);
    assert.equal(off.stats.denied, 5);
  `);
});

test("demand from Logpush stamps the lists it names", () => {
  runVersionsTest(`
    ${BAKE_SETUP}
    const seenAt = now;
    const result = await recordVersionsDemand({ DB: poolDb, GITHUB_CACHE: kv }, [
      "/data/github/quiet/repo/releases.json",
      "/data/github/quiet/repo/releases.json",
      "/data/github/fresh/repo/releases.json",
      "/data/github/nobody/repo/releases.json",
      "/data/github/Bad/Case/releases.json",
    ], seenAt);
    // quiet: stamped; nobody: stamped (no stamp yet); fresh: requested an
    // hour ago, already counted today; the duplicate and the bad path are
    // skipped.
    assert.deepEqual(result, { stamped: 2, unknown: 2 });
    assert.equal(storedEntry(kv, "github:versions-demand:releases:quiet/repo").requested_at, seenAt);
    assert.equal(storedEntry(kv, "github:versions-demand:releases:fresh/repo").requested_at, now - HOUR);
    // The lists themselves are never rewritten for demand.
    assert.ok(kv.writes.every((w) => w.key.startsWith("github:versions-demand:")));
  `);
});

test("a release published mid-crawl is not lost at a page boundary", () => {
  runVersionsTest(`
    github.releases = releases(300);
    // Page 3 answers at once from the old list; page 2 answers after v301 is
    // published, so on its own the crawl would miss v101.
    const realFetch = globalThis.fetch;
    let published = false;
    globalThis.fetch = async (input, init) => {
      const page = new URL(String(input)).searchParams.get("page");
      if (page === "2" && !published) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        github.releases.unshift(release(301));
        published = true;
      }
      return realFetch(input, init);
    };
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    const tags = versions.releases.map((r) => r.tag);
    assert.equal(tags.length, 301);
    assert.ok(tags.includes("v101"));
    assert.equal(tags[0], "v301");
    assert.equal(versions.truncated, false);
    // Crawled twice (page 1 moved), each checked by reading page 1 again.
    assert.equal(apiCalls().filter((c) => c.endsWith("page=1")).length, 3);
    assert.ok(storedEntry(kv, "github:versions:releases:o/r").full_at > 0);
  `);
});

test("a list that keeps moving keeps only page 1, with the full crawl left due", () => {
  runVersionsTest(`
    github.releases = releases(250);
    // Every read of page 1 sees one more release.
    const realFetch = globalThis.fetch;
    let next = 251;
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).searchParams.get("page") === "1") {
        github.releases.unshift(release(next++));
      }
      return realFetch(input, init);
    };
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    assert.equal(versions.releases.length, 100);
    assert.equal(versions.truncated, true);
    assert.equal(storedEntry(kv, "github:versions:releases:o/r").full_at, 0);
    assert.equal(__testing.refreshStep(storedEntry(kv, "github:versions:releases:o/r"), Date.now(), "releases"), "full");
  `);
});

test("pages still open at the deadline are cancelled and the prefix kept", () => {
  runVersionsTest(`
    __testing.setCrawlTiming({ budgetMs: 60_000, deadlineMs: 200 });
    github.releases = releases(350);
    const realFetch = globalThis.fetch;
    let aborted = 0;
    globalThis.fetch = async (input, init) => {
      // Like fetch: a request on an aborted signal fails at once.
      if (init?.signal?.aborted) throw init.signal.reason;
      const page = new URL(String(input)).searchParams.get("page");
      if (page === "3") {
        // Stalls until the crawl gives up on it.
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            aborted++;
            reject(init.signal.reason);
          });
        });
      }
      return realFetch(input, init);
    };
    const started = Date.now();
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    assert.ok(Date.now() - started < 2000, "returned near the deadline");
    // Page 1 could not be read again after the deadline: the pages read are
    // kept, and the full crawl is left due.
    assert.equal(storedEntry(kv, "github:versions:releases:o/r").full_at, 0);
    assert.equal(aborted, 1);
    // Pages 1-2 are kept; page 4 came back but follows the gap.
    assert.equal(versions.releases.length, 200);
    assert.equal(versions.releases.at(-1).tag, "v151");
    assert.equal(versions.truncated, true);
  `);
});
