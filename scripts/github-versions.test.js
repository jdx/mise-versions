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
    listVersionsChanges,
    recordVersionsBaked,
    refreshVersionLists,
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
    // ETags to answer with, and to honour If-None-Match against.
    etags: {},
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
    const etag = github.etags[kind];
    const ifNoneMatch = init?.headers?.["If-None-Match"];
    if (etag && ifNoneMatch === etag) return new Response(null, { status: 304 });
    if (github.failures[page] > 0) {
      github.failures[page]--;
      return new Response("timeout", { status: github.failStatus });
    }
    const all = github[kind];
    const perPage = Number(url.searchParams.get("per_page")) || 30;
    const last = Math.max(1, Math.ceil(all.length / perPage));
    const base = "https://api.github.com/repositories/1/" + kind + "?per_page=" + perPage + "&page=";
    const links = [];
    if (page < last) links.push("<" + base + (page + 1) + '>; rel="next"');
    if (page < last) links.push("<" + base + last + '>; rel="last"');
    const headers = links.length ? { link: links.join(", ") } : {};
    if (etag) headers.etag = etag;
    return new Response(JSON.stringify(all.slice((page - 1) * perPage, page * perPage)), {
      status: 200,
      headers,
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

  // A KV namespace in memory. An initial value of the form
  // { $value, $meta } is stored with metadata.
  function memoryKv(initial = {}) {
    const store = new Map();
    const meta = new Map();
    for (const [key, value] of Object.entries(initial)) {
      if (value && typeof value === "object" && "$value" in value) {
        store.set(key, JSON.stringify(value.$value));
        if (value.$meta) meta.set(key, value.$meta);
      } else {
        store.set(key, JSON.stringify(value));
      }
    }
    const writes = [];
    const read = (key, type) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    };
    return {
      store,
      meta,
      writes,
      get: async (key, type) =>
        Array.isArray(key)
          ? new Map(key.map((k) => [k, read(k, type)]))
          : read(key, type),
      getWithMetadata: async (key, type) => ({
        value: read(key, type),
        metadata: meta.get(key) ?? null,
      }),
      put: async (key, value, options) => {
        writes.push({ key, value, options });
        store.set(key, value);
        if (options?.metadata) meta.set(key, options.metadata);
        else meta.delete(key);
      },
      delete: async (key) => {
        store.delete(key);
        meta.delete(key);
      },
      list: async ({ prefix = "", cursor, limit = 1000 }) => {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + limit);
        const done = start + limit >= keys.length;
        return {
          keys: page.map((name) => (meta.has(name) ? { name, metadata: meta.get(name) } : { name })),
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
    // A probe of the newest 20 gives the page count, every page is read at
    // once, and the exact entry count (one per page) is read before and
    // after to check the pages join up.
    assert.deepEqual(apiCalls().sort(), [
      "/repos/Owner/Repo/releases?per_page=100&page=1",
      "/repos/Owner/Repo/releases?per_page=100&page=2",
      "/repos/Owner/Repo/releases?per_page=100&page=3",
      "/repos/Owner/Repo/releases?per_page=1&page=1",
      "/repos/Owner/Repo/releases?per_page=1&page=1",
      "/repos/Owner/Repo/releases?per_page=20&page=1",
    ].sort());
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
    assert.equal(kv.writes[0].options.expirationTtl, 30 * 24 * 60 * 60);
    // A list first read for a request (which passed the access check) is
    // bakeable from the start, and marked as changed for the next bake.
    const meta = kv.writes[0].options.metadata;
    assert.equal(meta.b, true);
    assert.ok(Date.now() - meta.c < 5000 && meta.c === meta.a);
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
    // 20 pages, the probe, and the entry count before and after.
    assert.equal(calls.length, 23);
    assert.ok(!calls.some((call) => call.endsWith("per_page=100&page=21")));
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
    // The probe said 10 pages of 20 (2 pages of 100), but a release was added:
    // page 2 now links a third, and its first entry repeats page 1's last.
    const result = await crawl(page([{ tag: "a" }], true, 10), async (n) => {
      fetched.push(n);
      if (n === 1) return page([{ tag: "a" }, { tag: "b" }], true);
      return n === 2 ? page([{ tag: "b" }, { tag: "c" }], true) : page([{ tag: "d" }], false);
    });
    assert.deepEqual(fetched, [1, 2, 3]);
    assert.deepEqual(result.items.map((item) => item.tag), ["a", "b", "c", "d"]);
    assert.equal(result.truncated, false);
  `);
});

test("crawls read big pages fewer at a time and stop when out of time", () => {
  runVersionsTest(`
    const { crawl } = __testing;
    const MB = 1024 * 1024;
    // A probe of 20 entries, a fifth the size of a page, saying 13 pages of 100.
    const probe = (pageBytes) => ({ items: [{ tag: "p1" }], hasNextPage: true, lastPage: 65, bytes: pageBytes / 5 });
    const page = (n) => ({ items: [{ tag: "p" + n }], hasNextPage: n < 13, lastPage: 13, bytes: 0 });
    async function maxInFlight(pageBytes) {
      let inFlight = 0;
      let max = 0;
      await crawl(probe(pageBytes), async (n) => {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return page(n);
      });
      return max;
    }
    // cli/cli-sized pages (4 MB) go 6 at a time, uv-sized (8 MB) 3,
    // codex-sized (32 MB) one at a time.
    assert.equal(await maxInFlight(4 * MB), 6);
    assert.equal(await maxInFlight(8 * MB), 3);
    assert.equal(await maxInFlight(32 * MB), 1);

    // Out of time already: the first batch (at most 3, before any page's
    // size is known) still runs, then the newest-first prefix is kept.
    const fetched = [];
    const late = await crawl(probe(MB), async (n) => {
      fetched.push(n);
      return page(n);
    }, Date.now() - 21 * 1000);
    assert.deepEqual(fetched, [1, 2, 3]);
    assert.equal(late.items.length, 3);
    assert.equal(late.truncated, true);

    // A batch took 60ms of a 100ms budget: another would overrun, so stop.
    __testing.setCrawlTiming({ budgetMs: 100 });
    const slow = await crawl(probe(MB), async (n) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return page(n);
    });
    assert.equal(slow.items.length, 3);
    assert.equal(slow.truncated, true);
    // A small probe (newest releases with few assets) followed by 32 MB
    // pages: after the first batch, pages are read one at a time.
    __testing.setCrawlTiming({ budgetMs: 20_000 });
    let inFlight = 0;
    const inFlightAt = [];
    await crawl(probe(MB), async (n) => {
      inFlight++;
      inFlightAt.push(inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ...page(n), bytes: 32 * MB };
    });
    assert.ok(Math.max(...inFlightAt.slice(0, 3)) <= 3);
    assert.ok(inFlightAt.slice(3).every((n) => n === 1), JSON.stringify(inFlightAt));
    // Fast batches all fit.
    const quick = await crawl(probe(MB), async (n) => page(n));
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
    // Only the probe of the newest 20 is read.
    assert.deepEqual(apiCalls(), ["/repos/o/r/releases?per_page=20&page=1"]);
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
    // The probe, the entry count, both pages at once, the count again.
    assert.deepEqual(apiCalls(), [
      "/repos/o/r/releases?per_page=20&page=1",
      "/repos/o/r/releases?per_page=1&page=1",
      "/repos/o/r/releases?per_page=100&page=1",
      "/repos/o/r/releases?per_page=100&page=2",
      "/repos/o/r/releases?per_page=1&page=1",
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
    // One query per page and for the probe; the entry counts need no dates.
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
    // Page 1 (with the probe and the pages read alongside it) is not retried.
    assert.equal(
      apiCalls().filter((call) => call.endsWith("per_page=100&page=1")).length,
      1,
    );
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
    // In metadata too, so the refresher reads all demand with list().
    assert.deepEqual(demandWrite.options, {
      expirationTtl: 35 * 24 * 60 * 60,
      metadata: { r: firstStamp },
    });

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
    // A cold crawl reads page 1 and the entry count alongside the probe.
    assert.deepEqual(apiCalls().sort(), [
      "/repos/o/r/releases?per_page=100&page=1",
      "/repos/o/r/releases?per_page=1&page=1",
      "/repos/o/r/releases?per_page=20&page=1",
    ].sort());
  `);
});

// Lists in KV with their metadata and demand, plus visibility answers.
const REFRESH_SETUP = `
  const now = Date.now();
  const item = (tag) => ({ tag, date: "d", prerelease: false, asset_count: 1 });
  const entry = { head_at: now - MIN, full_at: now - MIN, unchanged_since: now - MIN, items: [item("v1")], truncated: false };
  const meta = (extra) => ({ c: now - 2 * HOUR, b: true, a: now - MIN, h: now - MIN, f: now - MIN, u: now - MIN, r: now - HOUR, ...extra });
  const list = (extra = {}, value = {}) => ({ $value: { ...entry, ...value }, $meta: meta(extra) });
  const demand = (key, ago = HOUR) => ({
    ["github:versions-demand:" + key]: { $value: { requested_at: now - ago }, $meta: { r: now - ago } },
  });
  const visibility = (isPublic) => ({ cached_at: now, public: isPublic });
  const kv = memoryKv({
    "github:versions:releases:fresh/repo": list(),
    // Page 1 read an hour ago, after an hour unchanged: due.
    "github:versions:releases:due/repo": list(
      { h: now - HOUR, u: now - 2 * HOUR },
      { head_at: now - HOUR, unchanged_since: now - 2 * HOUR },
    ),
    // Nobody asked for 31 days: stop baking it.
    "github:versions:releases:quiet/repo": list(),
    // Access last checked 2 hours ago, and the repo is private now.
    "github:versions:releases:secret/repo": list({ a: now - 2 * HOUR }),
    // Written before lists had metadata.
    "github:versions:releases:legacy/repo": entry,
    ...demand("releases:fresh/repo"),
    ...demand("releases:due/repo"),
    ...demand("releases:quiet/repo", 31 * 24 * HOUR),
    ...demand("releases:secret/repo"),
    ...demand("releases:legacy/repo"),
    "github:visibility:fresh/repo": visibility(true),
    "github:visibility:due/repo": visibility(true),
    "github:visibility:quiet/repo": visibility(true),
    "github:visibility:secret/repo": visibility(false),
    "github:visibility:legacy/repo": visibility(true),
    "github:versions-state:baked": { at: now - 30 * MIN },
  });
  github.releases = releases(2);
  const env = { DB: poolDb, GITHUB_CACHE: kv, ANALYTICS_DB: {} };
  const dispatches = [];
  const dispatch = async () => { dispatches.push(Date.now()); };
`;

test("the refresher refreshes due lists, marks changes and dispatches a deploy", () => {
  runVersionsTest(`
    ${REFRESH_SETUP}
    const run = await refreshVersionLists(env, { dispatch });
    assert.deepEqual(run, {
      lists: 5, refreshed: 2, dropped: 2, added: 1, failed: 0, deferred: 0, changed: 4, dispatched: true,
    });
    // GitHub was asked only about the due list (the probe) and the legacy
    // one (a full crawl: probe, page 1 and the entry count).
    assert.deepEqual(apiCalls().sort(), [
      "/repos/due/repo/releases?per_page=20&page=1",
      "/repos/legacy/repo/releases?per_page=100&page=1",
      "/repos/legacy/repo/releases?per_page=1&page=1",
      "/repos/legacy/repo/releases?per_page=20&page=1",
    ].sort());
    const m = (key) => kv.meta.get("github:versions:releases:" + key);
    // Fresh: not touched at all.
    assert.ok(!kv.writes.some((w) => w.key === "github:versions:releases:fresh/repo"));
    // Due: refreshed (v2 is new), so its change time moved on.
    assert.ok(m("due/repo").c >= now && m("due/repo").b);
    assert.deepEqual(storedEntry(kv, "github:versions:releases:due/repo").items.map((r) => r.tag), ["v2", "v1"]);
    // Quiet and secret: no longer baked, marked as changed for the bake.
    assert.equal(m("quiet/repo").b, false);
    assert.ok(m("quiet/repo").c >= now);
    assert.equal(m("secret/repo").b, false);
    assert.ok(m("secret/repo").a >= now);
    // Legacy: checked, read in full, and baked from now on.
    assert.equal(m("legacy/repo").b, true);
    assert.ok(m("legacy/repo").c >= now);
    assert.equal(m("legacy/repo").r, now - HOUR);
    // One deploy, and the lease is given back.
    assert.equal(dispatches.length, 1);
    assert.ok(storedEntry(kv, "github:versions-state:dispatched").at >= now);
    assert.equal(kv.store.has("github:versions-state:refresher-lease"), false);

    // The next run finds nothing due, and the change is already dispatched.
    apiCalls();
    const again = await refreshVersionLists(env, { dispatch });
    assert.equal(again.refreshed, 0);
    assert.equal(again.changed, 0);
    assert.equal(again.dispatched, false);
    assert.deepEqual(apiCalls(), []);
  `);
});

test("deploys are dispatched only for changes not yet baked or in flight", () => {
  runVersionsTest(`
    ${REFRESH_SETUP}
    // Another run holds the lease: do nothing.
    kv.store.set("github:versions-state:refresher-lease", JSON.stringify({ until: now + MIN }));
    assert.equal((await refreshVersionLists(env, { dispatch })).skipped, "leased");
    assert.deepEqual(apiCalls(), []);
    kv.store.delete("github:versions-state:refresher-lease");

    // Every change is older than the last deployed bake: nothing to deploy.
    const quietEnv = {
      DB: poolDb,
      ANALYTICS_DB: {},
      GITHUB_CACHE: memoryKv({
        "github:versions:releases:fresh/repo": list(),
        ...demand("releases:fresh/repo"),
        "github:versions-state:baked": { at: now - MIN },
      }),
    };
    assert.equal((await refreshVersionLists(quietEnv, { dispatch })).dispatched, false);

    // A change after the bake, but a deploy was dispatched 5 minutes ago and
    // has not acknowledged yet: wait for it.
    quietEnv.GITHUB_CACHE.store.set("github:versions-state:baked", JSON.stringify({ at: now - 3 * HOUR }));
    quietEnv.GITHUB_CACHE.store.set("github:versions-state:dispatched", JSON.stringify({ at: now - 5 * MIN }));
    assert.equal((await refreshVersionLists(quietEnv, { dispatch })).dispatched, false);
    // A failed dispatch is not recorded, so the next run tries again.
    quietEnv.GITHUB_CACHE.store.set("github:versions-state:dispatched", JSON.stringify({ at: now - 31 * MIN }));
    const failedRun = await refreshVersionLists(quietEnv, {
      dispatch: async () => { throw new Error("GitHub said no"); },
    });
    assert.equal(failedRun.dispatched, false);
    assert.equal(storedEntry(quietEnv.GITHUB_CACHE, "github:versions-state:dispatched").at, now - 31 * MIN);
    // Dispatched 31 minutes ago and never acknowledged: dispatch again.
    quietEnv.GITHUB_CACHE.store.set("github:versions-state:dispatched", JSON.stringify({ at: now - 31 * MIN }));
    assert.equal((await refreshVersionLists(quietEnv, { dispatch })).dispatched, true);
    assert.equal(dispatches.length, 1);

    // A deploy acknowledges its bake; the watermark only moves forward.
    assert.equal(await recordVersionsBaked(quietEnv, now), now);
    assert.equal(await recordVersionsBaked(quietEnv, now - HOUR), now);
  `);
});

test("a probe GitHub answers 304 to leaves the list as it was", () => {
  runVersionsTest(`
    ${REFRESH_SETUP}
    github.etags.releases = '"probe-v1"';
    const key = "github:versions:releases:due/repo";
    kv.meta.set(key, { ...kv.meta.get(key), e: '"probe-v1"' });
    for (const other of ["quiet", "secret", "legacy"]) {
      kv.store.delete("github:versions:releases:" + other + "/repo");
    }
    const run = await refreshVersionLists(env, { dispatch });
    assert.equal(run.refreshed, 1);
    assert.equal(run.changed, 0);
    assert.equal(run.dispatched, false);
    assert.deepEqual(apiCalls(), ["/repos/due/repo/releases?per_page=20&page=1"]);
    const after = kv.meta.get(key);
    // Page 1 counts as read now; the content and its change time stay.
    assert.ok(after.h >= now);
    assert.equal(after.c, now - 2 * HOUR);
    assert.equal(after.e, '"probe-v1"');
    assert.deepEqual(storedEntry(kv, key).items.map((r) => r.tag), ["v1"]);
  `);
});

test("a refresher run is capped, and leaves the rest for the next run", () => {
  runVersionsTest(`
    ${REFRESH_SETUP}
    __testing.setRefreshTiming({ maxTasks: 2 });
    const run = await refreshVersionLists(env, { dispatch });
    // An unrequested list goes first (cheap, and it changes a bake), then
    // lists the refresher has never seen; the secret and due lists wait.
    assert.equal(run.dropped, 1);
    assert.equal(run.added, 1);
    assert.equal(run.refreshed, 1);
    assert.equal(run.deferred, 2);
    assert.equal(kv.meta.get("github:versions:releases:secret/repo").b, true);
  `);
});

test("the changes listing names lists changed or removed since a watermark", () => {
  runVersionsTest(`
    ${REFRESH_SETUP}
    kv.meta.set("github:versions:releases:due/repo", { ...kv.meta.get("github:versions:releases:due/repo"), c: now - 5 * MIN });
    kv.meta.set("github:versions:releases:quiet/repo", { ...kv.meta.get("github:versions:releases:quiet/repo"), b: false, c: now - 5 * MIN });
    const since = await listVersionsChanges(env, { since: now - HOUR });
    assert.deepEqual(since.files.map((f) => f.path), ["github/due/repo/releases.json"]);
    assert.deepEqual(since.deleted, ["github/quiet/repo/releases.json"]);
    assert.equal(since.cursor, null);
    assert.ok(since.now >= now);
    const body = JSON.parse(since.files[0].body);
    assert.equal(body.source, "releases");
    assert.deepEqual(body.releases, [item("v1")]);
    assert.equal(since.files[0].requested_at, now - HOUR);

    // Without a watermark: every baked list, nothing to delete. The legacy
    // list has no metadata yet, so it waits for the refresher.
    const full = await listVersionsChanges(env, {});
    assert.deepEqual(full.files.map((f) => f.path).sort(), [
      "github/due/repo/releases.json",
      "github/fresh/repo/releases.json",
      "github/secret/repo/releases.json",
    ]);
    assert.deepEqual(full.deleted, []);

    // Pages follow the KV listing; GitHub is never asked.
    const first = await listVersionsChanges(env, { limit: 2 });
    assert.ok(first.cursor);
    const second = await listVersionsChanges(env, { limit: 2, cursor: first.cursor });
    assert.equal(first.files.length + second.files.length > 0, true);
    assert.deepEqual(apiCalls(), []);
  `);
});

test("demand from Logpush stamps the lists it names", () => {
  runVersionsTest(`
    ${REFRESH_SETUP}
    const seenAt = now;
    kv.writes.length = 0;
    const result = await recordVersionsDemand(env, [
      "/data/github/quiet/repo/releases.json",
      "/data/github/quiet/repo/releases.json",
      "/data/github/fresh/repo/releases.json",
      "/data/github/nobody/repo/releases.json",
      "/data/github/Bad/Case/releases.json",
    ], seenAt);
    // quiet: stamped; nobody: stamped (no stamp yet); fresh: requested an
    // hour ago, already counted today; the duplicate is just a repeat; only
    // the bad path names no list.
    assert.deepEqual(result, { stamped: 2, unknown: 1 });
    assert.deepEqual(kv.meta.get("github:versions-demand:releases:quiet/repo"), { r: seenAt });
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
    // Crawled twice (the count moved): the count was read before, after the
    // first crawl and after the second.
    assert.equal(apiCalls().filter((c) => c.includes("per_page=1&")).length, 3);
    assert.ok(storedEntry(kv, "github:versions:releases:o/r").full_at > 0);
  `);
});

test("a list that keeps moving keeps only the probe, with the full crawl left due", () => {
  runVersionsTest(`
    github.releases = releases(250);
    // Every probe sees one more release.
    const realFetch = globalThis.fetch;
    let next = 251;
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).searchParams.get("per_page") === "20") {
        github.releases.unshift(release(next++));
      }
      return realFetch(input, init);
    };
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    assert.equal(versions.releases.length, 20);
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

test("a cold request is answered with the probe when the whole list takes too long", () => {
  runVersionsTest(`
    __testing.setCrawlTiming({ coldWaitMs: 50 });
    github.releases = releases(250);
    // Pages of 100 are slow; the probe is not.
    const realFetch = globalThis.fetch;
    let page1Ms = 200;
    globalThis.fetch = async (input, init) => {
      const params = new URL(String(input)).searchParams;
      if (params.get("per_page") === "100") {
        const ms = params.get("page") === "1" ? page1Ms : 200;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      return realFetch(input, init);
    };
    const kv = memoryKv();
    const background = [];
    const started = Date.now();
    const cold = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
      { waitUntil: (promise) => background.push(promise) },
    );
    assert.ok(Date.now() - started < 190, "answered before the pages came back");
    // The newest 20, truncated, kept at the edge only briefly.
    assert.equal(cold.versions.releases.length, 20);
    assert.equal(cold.versions.releases[0].tag, "v250");
    assert.equal(cold.versions.truncated, true);
    assert.equal(cold.edgeSeconds, 60);
    assert.equal(kv.store.has("github:versions:releases:o/r"), false);
    // The crawl finishes behind the answer and stores the whole list.
    await Promise.all(background);
    const stored = storedEntry(kv, "github:versions:releases:o/r");
    assert.equal(stored.items.length, 250);
    assert.equal(stored.truncated, false);

    // Page 1 came in before the wait ran out: answer with its 100 entries
    // rather than the probe's 20 (for tags sorted by name, older lines such
    // as tomcat 10.x are only on page 1).
    page1Ms = 10;
    __testing.setCrawlTiming({ coldWaitMs: 100 });
    const longer = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r2", { source: "releases" },
      { waitUntil: (promise) => background.push(promise) },
    );
    assert.equal(longer.versions.releases.length, 100);
    assert.equal(longer.versions.truncated, true);
    await Promise.all(background);

    // A list that is ready in time is answered whole.
    __testing.setCrawlTiming({ coldWaitMs: 2000 });
    const quick = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "other", { source: "releases" },
      { waitUntil: (promise) => background.push(promise) },
    );
    assert.equal(quick.versions.releases.length, 250);
    assert.equal(quick.versions.truncated, false);
  `);
});

test("a release deleted mid-crawl is not lost at a page boundary", () => {
  runVersionsTest(`
    github.releases = releases(250);
    // Page 1 answers from the full list; its 50th entry (v201) is deleted
    // before page 2 is read, so page 2 starts one later and, on its own, the
    // crawl would miss v150 (the 101st). The newest 20 and the probe's page
    // count stay the same.
    const realFetch = globalThis.fetch;
    let deleted = false;
    globalThis.fetch = async (input, init) => {
      const params = new URL(String(input)).searchParams;
      if (params.get("per_page") === "100" && params.get("page") === "2" && !deleted) {
        github.releases = github.releases.filter((r) => r.tag_name !== "v201");
        deleted = true;
      }
      return realFetch(input, init);
    };
    const kv = memoryKv();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: kv }, "o", "r", { source: "releases" },
    );
    const tags = versions.releases.map((r) => r.tag);
    assert.equal(tags.length, 249);
    assert.ok(tags.includes("v150"));
    assert.ok(!tags.includes("v201"));
    assert.equal(versions.truncated, false);
  `);
});

test("reads the crawl no longer needs are cancelled", () => {
  runVersionsTest(`
    github.releases = releases(5);
    // Page 1 of 100 never answers on its own: only the end of the refresh
    // can stop it. The probe (5 entries) is the whole list.
    const realFetch = globalThis.fetch;
    let cancelled = false;
    globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).searchParams.get("per_page") === "100") {
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => {
            cancelled = true;
            reject(init.signal.reason);
          });
        });
      }
      return realFetch(input, init);
    };
    const started = Date.now();
    const { versions } = await getCachedGitHubVersions(
      { DB: poolDb, GITHUB_CACHE: memoryKv() }, "o", "r", { source: "releases" },
    );
    assert.equal(versions.releases.length, 5);
    assert.ok(Date.now() - started < 1000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cancelled, true);
  `);
});
