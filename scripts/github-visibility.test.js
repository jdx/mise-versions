import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runMirrorTest(source) {
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

// Shared stubs: an in-memory KV and a fetch that answers /repos/{o}/{r}.
const PRELUDE = `
  import assert from "node:assert/strict";
  import {
    checkGitHubMirrorAccess,
    checkGitHubMirrorAccessVerified,
    isPublicGitHubRepo,
  } from "./web/src/lib/github/visibility.ts";

  function memoryKv(initial = {}) {
    const store = new Map(Object.entries(initial));
    const writes = [];
    return {
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

  function repoFetch(status, body) {
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body ?? {}), { status });
    };
    return calls;
  }

  function makeEnv(extra = {}) {
    return { DB: {}, ANALYTICS_DB: {}, GITHUB_CACHE: memoryKv(), ...extra };
  }
`;

test("public repos are allowed and cached for an hour", () => {
  runMirrorTest(`${PRELUDE}
    const env = makeEnv();
    const calls = repoFetch(200, { private: false, visibility: "public" });
    assert.equal(await isPublicGitHubRepo(env, "Owner", "Repo"), true);
    assert.deepEqual(calls, ["https://api.github.com/repos/Owner/Repo"]);
    assert.equal(env.GITHUB_CACHE.writes.length, 1);
    assert.equal(env.GITHUB_CACHE.writes[0].key, "github:visibility:owner/repo");
    // The entry outlives its answer (8 days) so the next check can carry
    // first_public_at over; the answer itself is trusted for an hour.
    assert.deepEqual(env.GITHUB_CACHE.writes[0].options, { expirationTtl: 8 * 86400 });
    const stored = JSON.parse(env.GITHUB_CACHE.writes[0].value);
    assert.equal(stored.public, true);
    assert.equal(stored.ttl, 3600);
    assert.ok(Math.abs(stored.first_public_at - Date.now()) < 5000);

    // Served from cache without asking GitHub again.
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
    assert.equal(calls.length, 1);
  `);
});

test("repos with more than 100 stars are re-checked daily", () => {
  runMirrorTest(`${PRELUDE}
    for (const [stars, ttl] of [[101, 86400], [100, 3600], [0, 3600], ["9999", 3600], [undefined, 3600]]) {
      const env = makeEnv();
      repoFetch(200, { private: false, visibility: "public", stargazers_count: stars });
      assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
      assert.equal(JSON.parse(env.GITHUB_CACHE.writes[0].value).ttl, ttl, String(stars));
    }
    // The star count is kept with the answer and reported by access checks,
    // so the mirror can use it without asking GitHub again.
    {
      const env = makeEnv();
      const calls = repoFetch(200, { private: false, visibility: "public", stargazers_count: 1234 });
      const first = await checkGitHubMirrorAccessVerified(env, "owner", "repo");
      assert.equal(first.stars, 1234);
      assert.equal(JSON.parse(env.GITHUB_CACHE.writes[0].value).stars, 1234);
      assert.equal((await checkGitHubMirrorAccessVerified(env, "owner", "repo")).stars, 1234);
      assert.equal(calls.length, 1);
      repoFetch(200, { private: false, visibility: "public", stargazers_count: "many" });
      const unknown = await checkGitHubMirrorAccessVerified(makeEnv(), "owner", "repo");
      assert.equal(unknown.stars, undefined);
    }
    // Stars never lengthen a "not public" answer.
    const env = makeEnv();
    repoFetch(200, { private: true, visibility: "private", stargazers_count: 5000 });
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
    const stored = JSON.parse(env.GITHUB_CACHE.writes[0].value);
    assert.equal(stored.ttl, 3600);
    assert.equal(stored.first_public_at, undefined);
  `);
});

test("a stored answer is trusted for its own TTL, at most a day", () => {
  runMirrorTest(`${PRELUDE}
    const hour = 3600 * 1000;
    const entry = (age, extra) =>
      JSON.stringify({ cached_at: Date.now() - age, public: true, ...extra });
    for (const [name, value, refetched] of [
      ["day TTL, 23h old", entry(23 * hour, { ttl: 86400 }), false],
      ["day TTL, 25h old", entry(25 * hour, { ttl: 86400 }), true],
      ["no TTL, 30m old", entry(hour / 2), false],
      ["no TTL, 2h old", entry(2 * hour), true],
      ["TTL over a day is capped", entry(25 * hour, { ttl: 7 * 86400 }), true],
      ["TTL under an hour is an hour", entry(hour / 2, { ttl: 1 }), false],
      ["unparsable TTL is an hour", entry(2 * hour, { ttl: "86400" }), true],
    ]) {
      const env = makeEnv({
        GITHUB_CACHE: memoryKv({ "github:visibility:owner/repo": value }),
      });
      const calls = repoFetch(200, { private: false, visibility: "public" });
      assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true, name);
      assert.equal(calls.length, refetched ? 1 : 0, name);
    }
  `);
});

test("repos public for over 30 days are re-checked daily", () => {
  runMirrorTest(`${PRELUDE}
    const day = 86400 * 1000;
    const now = Date.now();
    const recheck = async (previous) => {
      const env = makeEnv({
        GITHUB_CACHE: memoryKv(
          previous ? { "github:visibility:owner/repo": JSON.stringify(previous) } : {},
        ),
      });
      repoFetch(200, { private: false, visibility: "public", stargazers_count: 3 });
      assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
      return JSON.parse(env.GITHUB_CACHE.writes[0].value);
    };

    // Seen public for 31 days, last checked 2 hours ago: the run carries on.
    let next = await recheck({
      cached_at: now - 2 * 3600 * 1000, public: true, ttl: 3600, first_public_at: now - 31 * day,
    });
    assert.equal(next.first_public_at, now - 31 * day);
    assert.equal(next.ttl, 86400);

    // Seen public for 29 days: carried over, still an hour.
    next = await recheck({
      cached_at: now - 2 * 3600 * 1000, public: true, ttl: 3600, first_public_at: now - 29 * day,
    });
    assert.equal(next.first_public_at, now - 29 * day);
    assert.equal(next.ttl, 3600);

    // Entries from before first_public_at start the clock now.
    for (const previous of [
      undefined,
      { cached_at: now - 2 * 3600 * 1000, public: true },
      // Last seen not public: the run restarts.
      { cached_at: now - 2 * 3600 * 1000, public: false, first_public_at: now - 60 * day },
      // Not checked for over a week: it may have been private meanwhile.
      { cached_at: now - 8 * day, public: true, first_public_at: now - 60 * day },
      // From the future: not trusted.
      { cached_at: now - 2 * 3600 * 1000, public: true, first_public_at: now + day },
    ]) {
      next = await recheck(previous);
      assert.ok(Math.abs(next.first_public_at - Date.now()) < 5000, JSON.stringify(previous));
      assert.equal(next.ttl, 3600, JSON.stringify(previous));
    }

    // A repo that turns private or disappears loses its run.
    for (const [status, body] of [
      [200, { private: true, visibility: "private" }],
      [404, { message: "Not Found" }],
    ]) {
      const env = makeEnv({
        GITHUB_CACHE: memoryKv({
          "github:visibility:owner/repo": JSON.stringify({
            cached_at: now - 2 * day, public: true, ttl: 86400, first_public_at: now - 60 * day,
          }),
        }),
      });
      repoFetch(status, body);
      assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
      const stored = JSON.parse(env.GITHUB_CACHE.writes[0].value);
      assert.equal(stored.first_public_at, undefined);
      assert.equal(stored.ttl, 3600);
    }
  `);
});

test("memos from before TTLs are never read as an answer", () => {
  runMirrorTest(`${PRELUDE}
    import { readMemo, writeMemo } from "./web/src/lib/github/edge-memo.ts";
    import { gitHubRepoVisibility } from "./web/src/lib/github/visibility.ts";
    globalThis.caches = undefined;
    const env = makeEnv();
    // An older Worker memoized a bare boolean under the KV key; the new
    // answer shape lives under its own memo key, so neither version reads
    // the other's.
    const key = "github:visibility:owner/repo";
    await writeMemo(env.GITHUB_CACHE, key, true, Date.now() + 20 * 60 * 1000);
    const calls = repoFetch(200, { private: true, visibility: "private" });
    const answer = await gitHubRepoVisibility(env, "owner", "repo");
    assert.equal(calls.length, 1);
    assert.equal(answer.public, false);
    assert.equal(answer.ttlSeconds, 3600);
    assert.equal((await readMemo(env.GITHUB_CACHE, key)).value, true);
    assert.deepEqual((await readMemo(env.GITHUB_CACHE, key + "#ttl")).value, { p: false, t: 3600 });
  `);
});

test("anything but an explicit public answer is private", () => {
  runMirrorTest(`${PRELUDE}
    for (const body of [
      { private: true, visibility: "private" },
      { private: false, visibility: "internal" },
      { private: true, visibility: "public" },
      { visibility: "public" },
      { private: false },
      {},
    ]) {
      const env = makeEnv();
      repoFetch(200, body);
      assert.equal(
        await isPublicGitHubRepo(env, "owner", "repo"),
        false,
        JSON.stringify(body),
      );
      assert.equal(JSON.parse(env.GITHUB_CACHE.writes[0].value).public, false);
    }
  `);
});

test("missing repos are private and negatively cached", () => {
  runMirrorTest(`${PRELUDE}
    for (const status of [404, 451]) {
      const env = makeEnv();
      const calls = repoFetch(status, { message: "Not Found" });
      assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
      assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
      assert.equal(calls.length, 1);
    }
  `);
});

test("transient GitHub failures throw and are not cached", () => {
  runMirrorTest(`${PRELUDE}
    for (const status of [500, 502, 429]) {
      const env = makeEnv();
      repoFetch(status, { message: "boom" });
      await assert.rejects(() => isPublicGitHubRepo(env, "owner", "repo"));
      assert.equal(env.GITHUB_CACHE.writes.length, 0);
    }
  `);
});

test("expired or malformed cache entries are refetched", () => {
  runMirrorTest(`${PRELUDE}
    const stale = JSON.stringify({ cached_at: Date.now() - 2 * 3600 * 1000, public: true });
    const env = makeEnv({
      GITHUB_CACHE: memoryKv({ "github:visibility:owner/repo": stale }),
    });
    const calls = repoFetch(200, { private: true, visibility: "private" });
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), false);
    assert.equal(calls.length, 1);

    const env2 = makeEnv({
      GITHUB_CACHE: memoryKv({
        "github:visibility:owner/repo": JSON.stringify({ cached_at: Date.now(), public: "yes" }),
      }),
    });
    const calls2 = repoFetch(200, { private: false, visibility: "public" });
    assert.equal(await isPublicGitHubRepo(env2, "owner", "repo"), true);
    assert.equal(calls2.length, 1);
  `);
});

test("public mode serves public repos and 404s private ones", () => {
  runMirrorTest(`${PRELUDE}
    repoFetch(200, { private: false, visibility: "public" });
    assert.equal(await checkGitHubMirrorAccess(makeEnv(), "owner", "repo"), null);

    repoFetch(200, { private: true, visibility: "private" });
    const denied = await checkGitHubMirrorAccess(makeEnv(), "owner", "repo");
    assert.equal(denied.status, 404);
    assert.equal(denied.headers.get("cache-control"), "private, no-store");

    repoFetch(502, { message: "bad gateway" });
    const failed = await checkGitHubMirrorAccess(makeEnv(), "owner", "repo");
    assert.equal(failed.status, 503);
  `);
});

test("disabled mirror answers 403 without asking GitHub", () => {
  runMirrorTest(`${PRELUDE}
    const calls = repoFetch(200, { private: false, visibility: "public" });
    const denied = await checkGitHubMirrorAccess(
      makeEnv({ GITHUB_MIRROR_ACCESS: "off" }),
      "owner",
      "repo",
    );
    assert.equal(denied.status, 403);
    assert.equal(await denied.text(), "GitHub mirror is disabled");
    assert.equal(calls.length, 0);
  `);
});

test("registry mode 403s unregistered repos and still checks visibility", () => {
  runMirrorTest(`${PRELUDE}
    function analyticsDb(row) {
      return { prepare: () => ({ bind: () => ({ first: async () => row }) }) };
    }

    repoFetch(200, { private: false, visibility: "public" });
    const denied = await checkGitHubMirrorAccess(
      makeEnv({ GITHUB_MIRROR_ACCESS: "registry", ANALYTICS_DB: analyticsDb(null) }),
      "owner",
      "repo",
    );
    assert.equal(denied.status, 403);
    assert.equal(await denied.text(), "GitHub repo is not in the mise registry");

    assert.equal(
      await checkGitHubMirrorAccess(
        makeEnv({ GITHUB_MIRROR_ACCESS: "registry", ANALYTICS_DB: analyticsDb({ allowed: 1 }) }),
        "owner",
        "repo",
      ),
      null,
    );

    // Known attestation repos pass the registry gate for attestations only.
    assert.equal(
      await checkGitHubMirrorAccess(
        makeEnv({ GITHUB_MIRROR_ACCESS: "registry", ANALYTICS_DB: analyticsDb(null) }),
        "astral-sh",
        "python-build-standalone",
        { attestations: true },
      ),
      null,
    );

    // A registered repo that is private is still refused.
    repoFetch(200, { private: true, visibility: "private" });
    const hidden = await checkGitHubMirrorAccess(
      makeEnv({ GITHUB_MIRROR_ACCESS: "registry", ANALYTICS_DB: analyticsDb({ allowed: 1 }) }),
      "owner",
      "repo",
    );
    assert.equal(hidden.status, 404);
  `);
});

test("uncached lookups are rate limited per client", () => {
  runMirrorTest(`${PRELUDE}
    const keys = [];
    const limiter = (allow) => ({
      limit: async ({ key }) => {
        keys.push(key);
        return { success: allow };
      },
    });

    const calls = repoFetch(200, { private: false, visibility: "public" });
    const limited = await checkGitHubMirrorAccess(
      makeEnv({ GITHUB_VISIBILITY_LIMITER: limiter(false) }),
      "owner",
      "repo",
      { clientKey: "203.0.113.7" },
    );
    assert.equal(limited.status, 429);
    assert.deepEqual(keys, ["203.0.113.7"]);
    assert.equal(calls.length, 0);

    // Cached answers are served without spending the client's budget.
    const cachedEnv = makeEnv({
      GITHUB_VISIBILITY_LIMITER: limiter(false),
      GITHUB_CACHE: memoryKv({
        "github:visibility:owner/repo": JSON.stringify({ cached_at: Date.now(), public: true }),
      }),
    });
    keys.length = 0;
    assert.equal(
      await checkGitHubMirrorAccess(cachedEnv, "owner", "repo", { clientKey: "203.0.113.7" }),
      null,
    );
    assert.deepEqual(keys, []);

    assert.equal(
      await checkGitHubMirrorAccess(
        makeEnv({ GITHUB_VISIBILITY_LIMITER: limiter(true) }),
        "owner",
        "repo",
        { clientKey: "203.0.113.7" },
      ),
      null,
    );
  `);
});

test("a failed cache write does not fail the lookup", () => {
  runMirrorTest(`${PRELUDE}
    repoFetch(200, { private: false, visibility: "public" });
    const env = makeEnv({
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {
          throw new Error("KV write limit");
        },
      },
    });
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
  `);
});

test("draft releases are never mirrored by tag", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const writes = [];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        tag_name: "v2.0.0",
        draft: true,
        prerelease: false,
        created_at: "2026-01-01T00:00:00Z",
        assets: [{
          name: "a.tar.gz",
          browser_download_url: "https://github.com/o/r/releases/download/v2.0.0/a.tar.gz",
          url: "https://api.github.com/repos/o/r/releases/assets/1",
        }],
      }), { status: 200 });
    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value) => writes.push({ key, value }),
      },
    };
    await assert.rejects(
      () => getCachedGitHubRelease(env, "o", "r", "v2.0.0"),
      (error) => githubStatus(error) === 404,
    );
    // Nothing is cached: not the draft, and not a 404 that would hide the
    // release once it is published.
    assert.deepEqual(writes, []);
  `);
});

test("release list mirror fetches one page and drops drafts", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubReleaseList,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const calls = [];
    const writes = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify([
        {
          tag_name: "v2.0.0",
          draft: false,
          prerelease: false,
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-02T00:00:00Z",
          body: "dropped",
          assets: [{
            name: "tool.tar.gz",
            browser_download_url: "https://github.com/owner/repo/releases/download/v2.0.0/tool.tar.gz",
            url: "https://api.github.com/repos/owner/repo/releases/assets/1",
            digest: "sha256:00",
            updated_at: "2026-01-03T00:00:00Z",
            size: 10,
          }],
        },
        {
          tag_name: "v3.0.0",
          draft: true,
          prerelease: false,
          created_at: "2026-02-01T00:00:00Z",
          assets: [],
        },
      ]), { status: 200 });
    };
    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value, options) => writes.push({ key, value, options }),
      },
    };

    const { list, staleFallback } = await getCachedGitHubReleaseList(
      env, "Owner", "Repo", 2,
    );
    const { releases, next_page } = list;
    // Two raw entries, so this is the last page even before drafts are removed.
    assert.equal(next_page, null);
    assert.equal(list.truncated, false);
    assert.equal(staleFallback, false);
    assert.deepEqual(calls, [
      "https://api.github.com/repos/Owner/Repo/releases?per_page=100&page=2",
    ]);
    assert.deepEqual(releases, [{
      tag_name: "v2.0.0",
      draft: false,
      prerelease: false,
      created_at: "2026-01-01T00:00:00Z",
      published_at: "2026-01-02T00:00:00Z",
      assets: [{
        name: "tool.tar.gz",
        browser_download_url: "https://github.com/owner/repo/releases/download/v2.0.0/tool.tar.gz",
        url: "https://api.github.com/repos/owner/repo/releases/assets/1",
        digest: "sha256:00",
        updated_at: "2026-01-03T00:00:00Z",
      }],
    }]);
    assert.equal(writes[0].key, "github:releases:owner/repo:2");

    for (const page of [0, 11, 1.5]) {
      await assert.rejects(
        () => getCachedGitHubReleaseList(env, "owner", "repo", page),
        (error) => githubStatus(error) === 400,
      );
    }
  `);
});

test("release list pages report the next page from the unfiltered size", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { getCachedGitHubReleaseList } from "./web/src/lib/github/mirror.ts";

    // A full page where every release is a draft: nothing to publish, but
    // GitHub links a next page.
    let link = '<https://api.github.com/repositories/1/releases?page=2>; rel="next", <https://api.github.com/repositories/1/releases?page=20>; rel="last"';
    globalThis.fetch = async () =>
      new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
        tag_name: "draft-" + i,
        draft: true,
        prerelease: false,
        created_at: "2026-01-01T00:00:00Z",
        assets: [],
      }))), { status: 200, headers: link ? { link } : {} });
    const env = {
      DB: {},
      GITHUB_CACHE: { get: async () => null, put: async () => {} },
    };
    const { list: middle } = await getCachedGitHubReleaseList(env, "owner", "repo", 4);
    assert.deepEqual(middle, { releases: [], next_page: 5, truncated: false });
    // The mirror stops at its last page and says the rest is GitHub's.
    const { list: last } = await getCachedGitHubReleaseList(env, "owner", "repo", 10);
    assert.deepEqual(last, { releases: [], next_page: null, truncated: true });

    // A full page with no next link is the end, even at the last page.
    link = '<https://api.github.com/repositories/1/releases?page=1>; rel="first", <https://api.github.com/repositories/1/releases?page=9>; rel="prev"';
    const { list: exact } = await getCachedGitHubReleaseList(env, "owner", "repo", 10);
    assert.deepEqual(exact, { releases: [], next_page: null, truncated: false });
    link = null;
    const { list: unlinked } = await getCachedGitHubReleaseList(env, "owner", "repo", 3);
    assert.deepEqual(unlinked, { releases: [], next_page: null, truncated: false });
  `);
});

test("untracked latest releases refresh after ten minutes", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { getCachedGitHubRelease } from "./web/src/lib/github/mirror.ts";

    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const cachedRelease = {
      tag_name: "v1.0.0",
      draft: false,
      prerelease: false,
      created_at: old,
      published_at: old,
      immutable: false,
      assets: [{
        name: "a.tar.gz",
        browser_download_url: "https://github.com/o/r/releases/download/v1.0.0/a.tar.gz",
        url: "https://api.github.com/repos/o/r/releases/assets/1",
      }],
    };
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response(JSON.stringify({ ...cachedRelease, tag_name: "v2.0.0" }), { status: 200 });
    };
    function envCachedAgo(ms) {
      return {
        DB: {},
        GITHUB_CACHE: {
          get: async (key) =>
            key === "github:release:o/r:latest"
              ? { cached_at: Date.now() - ms, data: cachedRelease }
              : null,
          put: async () => {},
        },
      };
    }

    assert.equal(
      (await getCachedGitHubRelease(envCachedAgo(5 * 60 * 1000), "o", "r", "latest")).tag_name,
      "v1.0.0",
    );
    assert.equal(fetches, 0);
    assert.equal(
      (await getCachedGitHubRelease(envCachedAgo(15 * 60 * 1000), "o", "r", "latest")).tag_name,
      "v2.0.0",
    );
    assert.equal(fetches, 1);
  `);
});

test("untracked latest and release-list page 1 back off while unchanged", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      getCachedGitHubReleaseList,
      getCachedGitHubReleaseResult,
    } from "./web/src/lib/github/mirror.ts";

    const minute = 60 * 1000;
    const hour = 60 * minute;
    const old = new Date(Date.now() - 30 * 24 * hour).toISOString();
    const release = (tag, publishedAt = old) => ({
      tag_name: tag,
      draft: false,
      prerelease: false,
      created_at: publishedAt,
      published_at: publishedAt,
      assets: [{
        name: "a.tar.gz",
        browser_download_url: "https://github.com/o/r/releases/download/" + tag + "/a.tar.gz",
        url: "https://api.github.com/repos/o/r/releases/assets/1",
      }],
    });
    let upstream = release("v1.0.0");
    let fetches = 0;
    globalThis.fetch = async (url) => {
      fetches++;
      const body = String(url).includes("/releases?") ? [upstream] : upstream;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    function kv(initial = {}) {
      const store = new Map(Object.entries(initial));
      return {
        store,
        get: async (key) => store.get(key) ?? null,
        put: async (key, value) => store.set(key, JSON.parse(value)),
      };
    }
    const env = (initial) => ({ DB: {}, GITHUB_CACHE: kv(initial) });

    // A first read records since when the answer has been the same.
    const first = env();
    await getCachedGitHubRelease(first, "o", "r", "latest");
    assert.equal(fetches, 1);
    const stored = first.GITHUB_CACHE.store.get("github:release:o/r:latest");
    assert.equal(stored.unchanged_since, stored.cached_at);

    // [age of the entry, how long it had been unchanged when cached, refetched?]
    for (const [age, stable, refetched] of [
      [5 * minute, 0, false],
      [15 * minute, 0, true], // just changed: ten minutes
      [20 * minute, 2 * hour, false], // stable 2h: 30 minutes
      [35 * minute, 2 * hour, true],
      [50 * minute, 10 * hour, false], // capped at an hour
      [65 * minute, 10 * hour, true],
    ]) {
      const cachedAt = Date.now() - age;
      const data = { ...stored.data };
      for (const [key, page] of [
        ["github:release:o/r:latest", null],
        ["github:releases:o/r:1", 1],
      ]) {
        fetches = 0;
        const entry = {
          cached_at: cachedAt,
          unchanged_since: cachedAt - stable,
          data: page ? { releases: [], next_page: null, truncated: false } : data,
        };
        const e = env({ [key]: entry });
        if (page) await getCachedGitHubReleaseList(e, "o", "r", 1);
        else await getCachedGitHubRelease(e, "o", "r", "latest");
        assert.equal(fetches, refetched ? 1 : 0, key + " " + age + " " + stable);
      }
    }

    // A refresh that finds the same answer keeps its unchanged_since; a new
    // release resets it.
    const since = Date.now() - 10 * hour;
    const same = env({
      "github:release:o/r:latest": {
        cached_at: Date.now() - 2 * hour, unchanged_since: since, data: stored.data,
      },
    });
    await getCachedGitHubRelease(same, "o", "r", "latest");
    assert.equal(same.GITHUB_CACHE.store.get("github:release:o/r:latest").unchanged_since, since);
    upstream = release("v2.0.0");
    const changed = env({
      "github:release:o/r:latest": {
        cached_at: Date.now() - 2 * hour, unchanged_since: since, data: stored.data,
      },
    });
    assert.equal((await getCachedGitHubRelease(changed, "o", "r", "latest")).tag_name, "v2.0.0");
    const next = changed.GITHUB_CACHE.store.get("github:release:o/r:latest");
    assert.equal(next.unchanged_since, next.cached_at);

    // A young release still refreshes every 30 minutes however stable.
    const young = new Date(Date.now() - 24 * hour).toISOString();
    fetches = 0;
    await getCachedGitHubRelease(
      env({
        "github:release:o/r:latest": {
          cached_at: Date.now() - 40 * minute,
          unchanged_since: Date.now() - 20 * hour,
          data: { ...stored.data, published_at: young },
        },
      }),
      "o", "r", "latest",
    );
    assert.equal(fetches, 1);

    // A page 1 holding a young release (or one without a parsable date) is
    // re-read after 30 minutes however stable, so a replaced asset's digest
    // is picked up as fast as through that release's own entry.
    const youngRelease = (publishedAt) => ({
      tag_name: "v3.0.0",
      draft: false,
      prerelease: false,
      created_at: publishedAt,
      published_at: publishedAt,
      assets: [{
        name: "a.tar.gz",
        browser_download_url: "https://github.com/o/r/releases/download/v3.0.0/a.tar.gz",
        url: "https://api.github.com/repos/o/r/releases/assets/3",
        digest: "sha256:" + "0".repeat(64),
        updated_at: publishedAt,
      }],
    });
    for (const [name, releases, age, refetched] of [
      ["young, 40m old", [youngRelease(young)], 40 * minute, true],
      ["young, 20m old", [youngRelease(young)], 20 * minute, false],
      ["undated, 40m old", [{ ...youngRelease(null), created_at: "soon" }], 40 * minute, true],
      ["old, 40m old", [youngRelease(old)], 40 * minute, false],
    ]) {
      fetches = 0;
      await getCachedGitHubReleaseList(
        env({
          "github:releases:o/r:1": {
            cached_at: Date.now() - age,
            unchanged_since: Date.now() - age - 20 * hour,
            data: { releases, next_page: null, truncated: false },
          },
        }),
        "o", "r", 1,
      );
      assert.equal(fetches, refetched ? 1 : 0, name);
    }

    // Untracked repos with 1000+ stars keep the 10-minute window; fewer
    // stars, or an unknown count, back off. The young-release cap on page 1
    // still applies below the threshold.
    const pageOf = (releases) => ({ releases, next_page: null, truncated: false });
    for (const [stars, age, data, refetched] of [
      [1000, 15 * minute, null, true],
      [50000, 15 * minute, null, true],
      [1000, 5 * minute, null, false],
      [999, 15 * minute, null, false],
      [undefined, 15 * minute, null, false],
      [999, 40 * minute, [youngRelease(young)], true],
      [999, 20 * minute, [youngRelease(young)], false],
    ]) {
      for (const [key, page] of [
        ["github:release:o/r:latest", null],
        ["github:releases:o/r:1", 1],
      ]) {
        if (data && !page) continue;
        fetches = 0;
        const e = env({
          [key]: {
            cached_at: Date.now() - age,
            unchanged_since: Date.now() - age - 20 * hour,
            data: page ? pageOf(data ?? []) : stored.data,
          },
        });
        if (page) await getCachedGitHubReleaseList(e, "o", "r", 1, undefined, { stars });
        else await getCachedGitHubReleaseResult(e, "o", "r", "latest", undefined, undefined, { stars });
        assert.equal(fetches, refetched ? 1 : 0, key + " stars=" + stars + " age=" + age);
      }
    }

    // Tracked repos (with a generation) and later pages keep their windows.
    for (const [page, generation, age] of [[1, "a".repeat(64), 15 * minute], [2, undefined, 65 * minute]]) {
      fetches = 0;
      const key = "github:releases:o/r:" + page + (generation ? ":" + generation : "");
      await getCachedGitHubReleaseList(
        env({
          [key]: {
            cached_at: Date.now() - age,
            unchanged_since: Date.now() - 30 * hour,
            data: { releases: [], next_page: null, truncated: false },
          },
        }),
        "o", "r", page, generation,
      );
      assert.equal(fetches, 1, key);
    }
  `);
});

test("edge cache keys keep only the params a handler passes back", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { __testing } from "./web/src/lib/github/mirror.ts";

    const request = new Request(
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=02&junk=1",
    );
    assert.equal(
      __testing.edgeCacheRequest(request, undefined, { page: "2" }).url,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases?page=2",
    );
    assert.equal(
      __testing.edgeCacheRequest(request).url,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/releases",
    );
  `);
});
