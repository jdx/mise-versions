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
    assert.deepEqual(env.GITHUB_CACHE.writes[0].options, { expirationTtl: 3600 });

    // Served from cache without asking GitHub again.
    assert.equal(await isPublicGitHubRepo(env, "owner", "repo"), true);
    assert.equal(calls.length, 1);
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
