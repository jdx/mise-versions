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

// Two GitHub tag objects as /repos/{o}/{r}/tags returns them. Both point at
// the same commit, as a re-tag would.
const TAGS_PRELUDE = `
  import assert from "node:assert/strict";
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  function restTag(name, sha) {
    return {
      name,
      zipball_url: "https://api.github.com/repos/o/r/zipball/refs/tags/" + name,
      tarball_url: "https://api.github.com/repos/o/r/tarball/refs/tags/" + name,
      commit: { sha, url: "https://api.github.com/repos/o/r/commits/" + sha },
      node_id: "dropped",
    };
  }
  const REST_TAGS = [
    restTag("v2.0.0", SHA_A),
    restTag("v2.0.0-rc1", SHA_A),
    restTag("v1.0.0", SHA_B),
  ];
`;

test("tag list mirror fetches one page in GitHub's order", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import {
      getCachedGitHubTagList,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const calls = [];
    const writes = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify(REST_TAGS), {
        status: 200,
        headers: {
          link: '<https://api.github.com/repositories/1/tags?per_page=100&page=3>; rel="next"',
        },
      });
    };
    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value, options) => writes.push({ key, value, options }),
      },
    };

    const { list, staleFallback } = await getCachedGitHubTagList(
      env, "Owner", "Repo", 2,
    );
    assert.equal(staleFallback, false);
    assert.deepEqual(calls, [{
      url: "https://api.github.com/repos/Owner/Repo/tags?per_page=100&page=2",
      method: "GET",
    }]);
    assert.deepEqual(list, {
      tags: [
        { name: "v2.0.0", commit: { sha: SHA_A, url: "https://api.github.com/repos/o/r/commits/" + SHA_A } },
        { name: "v2.0.0-rc1", commit: { sha: SHA_A, url: "https://api.github.com/repos/o/r/commits/" + SHA_A } },
        { name: "v1.0.0", commit: { sha: SHA_B, url: "https://api.github.com/repos/o/r/commits/" + SHA_B } },
      ],
      next_page: 3,
      truncated: false,
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, "github:tags:owner/repo:2");
    assert.deepEqual(writes[0].options, { expirationTtl: 30 * 24 * 60 * 60 });

    // The mirror stops at its last page and says the rest is GitHub's.
    const { list: last } = await getCachedGitHubTagList(env, "o", "r", 10);
    assert.equal(last.next_page, null);
    assert.equal(last.truncated, true);

    for (const page of [0, 11, 1.5]) {
      await assert.rejects(
        () => getCachedGitHubTagList(env, "o", "r", page),
        (error) => githubStatus(error) === 400,
      );
    }
  `);
});

test("tag list pages refresh like the release list", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import {
      getCachedGitHubTagList,
      tagListFreshSeconds,
    } from "./web/src/lib/github/mirror.ts";

    assert.equal(tagListFreshSeconds(1), 10 * 60);
    assert.equal(tagListFreshSeconds(2), 60 * 60);
    assert.equal(tagListFreshSeconds(10), 60 * 60);

    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response(JSON.stringify(REST_TAGS), { status: 200 });
    };
    function envCachedAgo(key, ms) {
      return {
        DB: {},
        GITHUB_CACHE: {
          get: async (k) =>
            k === key
              ? {
                  cached_at: Date.now() - ms,
                  data: { tags: [], next_page: null, truncated: false },
                }
              : null,
          put: async () => {},
        },
      };
    }

    const fresh = await getCachedGitHubTagList(
      envCachedAgo("github:tags:o/r:1", 5 * 60 * 1000), "o", "r", 1,
    );
    assert.deepEqual(fresh.list.tags, []);
    assert.equal(fetches, 0);
    const refreshed = await getCachedGitHubTagList(
      envCachedAgo("github:tags:o/r:1", 15 * 60 * 1000), "o", "r", 1,
    );
    assert.equal(refreshed.list.tags.length, 3);
    assert.equal(fetches, 1);
    // A later page stays fresh for an hour.
    await getCachedGitHubTagList(
      envCachedAgo("github:tags:o/r:2", 30 * 60 * 1000), "o", "r", 2,
    );
    assert.equal(fetches, 1);
  `);
});

test("tag list mirror serves a stale page when GitHub fails", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import { getCachedGitHubTagList } from "./web/src/lib/github/mirror.ts";

    globalThis.fetch = async () => new Response("boom", { status: 502 });
    const stale = { tags: [{ name: "v0", commit: { sha: SHA_A, url: "u" } }], next_page: null, truncated: false };
    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => ({ cached_at: Date.now() - 2 * 60 * 60 * 1000, data: stale }),
        put: async () => assert.fail("a failed refresh must not write"),
      },
    };
    const { list, staleFallback } = await getCachedGitHubTagList(env, "o", "r", 2);
    assert.equal(staleFallback, true);
    assert.deepEqual(list, stale);
  `);
});

test("tag list mirror refuses malformed GitHub responses", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import {
      getCachedGitHubTagList,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const env = {
      DB: {},
      GITHUB_CACHE: { get: async () => null, put: async () => assert.fail("must not cache") },
    };
    for (const body of [{ message: "not a list" }, [{ name: "v1" }], [{ commit: { sha: SHA_A, url: "u" } }]]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await assert.rejects(
        () => getCachedGitHubTagList(env, "o", "r", 1),
        (error) => githubStatus(error) === 502,
      );
    }
  `);
});

test("dated tag lists add commit dates from one GraphQL query", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import { __testing } from "./web/src/lib/github/mirror.ts";

    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "https://api.github.com/graphql") {
        return new Response(JSON.stringify({
          data: {
            repository: {
              c0: { committedDate: "2026-02-01T00:00:00Z" },
              // GitHub doesn't know this commit.
              c1: null,
            },
          },
        }), { status: 200, headers: { "x-ratelimit-remaining": "4999" } });
      }
      return new Response(JSON.stringify(REST_TAGS), { status: 200 });
    };
    const token = { id: 7, token: "pool-token" };

    const list = await __testing.fetchGitHubTagList("o", "r", 1, true, token);
    assert.deepEqual(
      list.tags.map((tag) => [tag.name, tag.date]),
      [
        ["v2.0.0", "2026-02-01T00:00:00Z"],
        ["v2.0.0-rc1", "2026-02-01T00:00:00Z"],
        ["v1.0.0", null],
      ],
    );
    assert.equal(calls.length, 2);
    const graphql = calls[1];
    assert.equal(graphql.init.method, "POST");
    assert.equal(graphql.init.headers.Authorization, "Bearer pool-token");
    const { query, variables } = JSON.parse(graphql.init.body);
    // Each commit is asked for once, and SHAs travel as variables.
    assert.deepEqual(variables, { owner: "o", name: "r", c0: SHA_A, c1: SHA_B });
    assert.ok(!query.includes(SHA_A));
    assert.match(query, /repository\\(owner: \\$owner, name: \\$name\\)/);
    assert.equal(token.remaining, 4999);
  `);
});

test("dated tag lists are cached apart and need a pool token", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import {
      __testing,
      getCachedGitHubTagList,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(REST_TAGS), { status: 200 });
    };
    const reads = [];
    const env = {
      // No usable D1, so no pool token.
      DB: {},
      GITHUB_CACHE: {
        get: async (key) => { reads.push(key); return null; },
        put: async () => assert.fail("must not cache"),
      },
    };
    // GitHub's GraphQL API refuses anonymous requests, so don't send one.
    await assert.rejects(
      () => getCachedGitHubTagList(env, "o", "r", 1, { dates: true }),
      (error) => githubStatus(error) === 503,
    );
    assert.deepEqual(reads, ["github:tags-dated:o/r:1"]);
    assert.ok(!urls.includes("https://api.github.com/graphql"));

    // An empty page needs no dates and no token.
    globalThis.fetch = async () => new Response("[]", { status: 200 });
    const empty = await __testing.fetchGitHubTagList("o", "r", 1, true, null);
    assert.deepEqual(empty.tags, []);
  `);
});

test("GraphQL rate limits mark the token like REST ones", () => {
  runMirrorTest(`
    ${TAGS_PRELUDE}
    import {
      __testing,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const reset = String(Math.floor(Date.now() / 1000) + 600);
    globalThis.fetch = async (url) =>
      String(url) === "https://api.github.com/graphql"
        ? new Response(JSON.stringify({
            data: null,
            errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
          }), {
            status: 200,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
          })
        : new Response(JSON.stringify(REST_TAGS), { status: 200 });

    const token = { id: 7, token: "pool-token" };
    await assert.rejects(
      () => __testing.fetchGitHubTagList("o", "r", 1, true, token),
      (error) =>
        githubStatus(error) === 403 &&
        __testing.isRateLimited(error) &&
        __testing.resetAt(error) === new Date(Number(reset) * 1000).toISOString(),
    );
    assert.equal(token.remaining, 0);

    // Other GraphQL failures are upstream errors, not rate limits.
    globalThis.fetch = async (url) =>
      String(url) === "https://api.github.com/graphql"
        ? new Response(JSON.stringify({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "gone" }] }), { status: 200 })
        : new Response(JSON.stringify(REST_TAGS), { status: 200 });
    await assert.rejects(
      () => __testing.fetchGitHubTagList("o", "r", 1, true, { id: 8, token: "t" }),
      (error) => githubStatus(error) === 502 && !__testing.isRateLimited(error),
    );
  `);
});

test("edge cache keys keep the tag list's page and dates params", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { __testing } from "./web/src/lib/github/mirror.ts";

    const request = new Request(
      "https://mise-versions.jdx.dev/api/github/repos/o/r/tags?dates=true&page=01&junk=1",
    );
    assert.equal(
      __testing.edgeCacheRequest(request, undefined, { page: "1", dates: "1" }).url,
      "https://mise-versions.jdx.dev/api/github/repos/o/r/tags?page=1&dates=1",
    );
  `);
});
