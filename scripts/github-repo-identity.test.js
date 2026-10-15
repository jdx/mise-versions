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

// Runs a route handler: `cloudflare:workers` resolves to a module whose `env`
// is globalThis.__env, and the Cache API is an in-memory map.
const WORKERS_STUB = `data:text/javascript,${encodeURIComponent(
  `export async function resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return {
        url: "data:text/javascript,export const env = globalThis.__env;",
        shortCircuit: true,
      };
    }
    return next(specifier, context);
  }`,
)}`;
const REGISTER = `data:text/javascript,${encodeURIComponent(
  `import { register } from "node:module"; register(${JSON.stringify(WORKERS_STUB)});`,
)}`;

function runRouteTest(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", REGISTER, "--input-type=module"],
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
  import { getCachedGitHubRepoIdentity } from "./web/src/lib/github/repo-identity.ts";
  import { githubStatus } from "./web/src/lib/github/mirror.ts";

  const requests = [];
  let reply = () => new Response("{}", { status: 500 });
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return reply(String(url));
  };
  const store = new Map();
  const writes = [];
  const env = {
    DB: {},
    GITHUB_CACHE: {
      get: async (key) => (store.has(key) ? JSON.parse(store.get(key)) : null),
      put: async (key, value, options) => {
        store.set(key, value);
        writes.push({ key, options });
      },
    },
  };
  const repo = {
    id: 123,
    full_name: "new-owner/new-name",
    owner: { id: 456, login: "new-owner" },
    private: false,
    visibility: "public",
    stargazers_count: 9,
  };
`;

test("repository identity follows GitHub's rename redirect", () => {
  runMirrorTest(`${PRELUDE}
    reply = (url) =>
      url === "https://api.github.com/repos/Old-Owner/old-name"
        ? new Response(null, {
            status: 301,
            headers: { location: "https://api.github.com/repositories/123" },
          })
        : Response.json(repo);

    const identity = await getCachedGitHubRepoIdentity(env, "Old-Owner", "old-name");
    assert.deepEqual(identity, {
      id: 123,
      full_name: "new-owner/new-name",
      owner: { id: 456 },
    });
    assert.deepEqual(requests, [
      "https://api.github.com/repos/Old-Owner/old-name",
      "https://api.github.com/repositories/123",
    ]);
    assert.deepEqual(writes, [
      {
        key: "github:repo-identity:old-owner/old-name",
        options: { expirationTtl: 6 * 60 * 60 },
      },
    ]);

    // Served from KV for 6 hours, then asked again.
    assert.deepEqual(
      await getCachedGitHubRepoIdentity(env, "old-owner", "old-name"),
      identity,
    );
    assert.equal(requests.length, 2);
    const entry = JSON.parse(store.get("github:repo-identity:old-owner/old-name"));
    entry.cached_at -= 6 * 60 * 60 * 1000;
    store.set("github:repo-identity:old-owner/old-name", JSON.stringify(entry));
    await getCachedGitHubRepoIdentity(env, "old-owner", "old-name");
    assert.equal(requests[2], "https://api.github.com/repos/old-owner/old-name");
  `);
});

test("repository identity is a 404 for anything but a public repo", () => {
  runMirrorTest(`${PRELUDE}
    for (const answer of [
      { ...repo, private: true, visibility: "private" },
      { ...repo, visibility: "internal" },
      { ...repo, private: undefined },
    ]) {
      reply = () => Response.json(answer);
      await assert.rejects(
        () => getCachedGitHubRepoIdentity(env, "owner", "repo"),
        (error) => githubStatus(error) === 404,
      );
    }
    reply = () => new Response('{"message":"Not Found"}', { status: 404 });
    await assert.rejects(
      () => getCachedGitHubRepoIdentity(env, "owner", "repo"),
      (error) => githubStatus(error) === 404,
    );
    assert.equal(writes.length, 0);
  `);
});

test("repository identity rejects answers without an id", () => {
  runMirrorTest(`${PRELUDE}
    reply = () => Response.json({ ...repo, owner: {} });
    await assert.rejects(
      () => getCachedGitHubRepoIdentity(env, "owner", "repo"),
      (error) => githubStatus(error) === 502,
    );
    assert.equal(writes.length, 0);
  `);
});

test("the repository route checks access first, and keeps answers no longer than KV does", () => {
  runRouteTest(`
    import assert from "node:assert/strict";
    const edge = new Map();
    globalThis.caches = {
      default: {
        match: async (request) => edge.get(request.url)?.clone(),
        put: async (request, response) => edge.set(request.url, response),
        delete: async (request) => edge.delete(request.url),
      },
    };
    const kv = new Map();
    const now = Date.now();
    // Every repo but "secret" has already passed the visibility check.
    for (const name of ["repo", "aging", "gone", "limited", "broken"]) {
      kv.set(
        "github:visibility:owner/" + name,
        JSON.stringify({ cached_at: now, public: true }),
      );
    }
    kv.set(
      "github:visibility:owner/secret",
      JSON.stringify({ cached_at: now, public: false }),
    );
    // Stored 5 hours ago: 1 hour of its 6 is left.
    kv.set(
      "github:repo-identity:owner/aging",
      JSON.stringify({
        cached_at: now - 5 * 60 * 60 * 1000,
        data: { id: 2, full_name: "owner/aging", owner: { id: 3 } },
      }),
    );
    globalThis.__env = {
      DB: {},
      ANALYTICS_DB: {},
      GITHUB_CACHE: {
        get: async (key, type) =>
          kv.has(key)
            ? type === "json" ? JSON.parse(kv.get(key)) : kv.get(key)
            : null,
        put: async (key, value) => kv.set(key, value),
        delete: async (key) => kv.delete(key),
      },
    };
    globalThis.fetch = async (url) => {
      switch (String(url)) {
        case "https://api.github.com/repos/owner/repo":
          return Response.json({
            id: 1,
            full_name: "new-owner/repo",
            owner: { id: 9 },
            private: false,
            visibility: "public",
          });
        case "https://api.github.com/repos/owner/gone":
          return new Response('{"message":"Repository access blocked"}', { status: 451 });
        case "https://api.github.com/repos/owner/limited":
          return new Response('{"message":"rate limited"}', {
            status: 429,
            headers: { "retry-after": "60" },
          });
        default:
          return new Response("oops", { status: 500 });
      }
    };
    const { GET } = await import(
      "./web/src/pages/api/github/repos/[owner]/[repo]/index.ts"
    );
    const pending = [];
    const url = (repo) => "https://mise-versions.jdx.dev/api/github/repos/owner/" + repo;
    const call = (repo) =>
      GET({
        params: { owner: "owner", repo },
        request: new Request(url(repo)),
        locals: { cfContext: { waitUntil: (promise) => pending.push(promise) } },
      });

    const fresh = await call("repo");
    assert.equal(fresh.status, 200);
    assert.deepEqual(await fresh.json(), {
      id: 1,
      full_name: "new-owner/repo",
      owner: { id: 9 },
    });
    assert.equal(
      fresh.headers.get("cache-control"),
      "public, max-age=3600, s-maxage=21600",
    );

    // Only what is left of the KV entry's 6 hours, at the edge and in browsers.
    const aging = await call("aging");
    const [, maxAge, sMaxAge] = aging.headers
      .get("cache-control")
      .match(/max-age=(\\d+), s-maxage=(\\d+)/);
    assert.ok(Number(sMaxAge) <= 3600 && Number(sMaxAge) > 3500, sMaxAge);
    assert.equal(maxAge, sMaxAge);
    await Promise.all(pending);
    assert.match(
      (await edge.get(url("aging")).clone()).headers.get("cache-control"),
      new RegExp("s-maxage=" + sMaxAge),
    );

    // A private repo is a 404 even with an answer at the edge.
    edge.set(url("secret"), Response.json({ id: 4 }));
    assert.equal((await call("secret")).status, 404);

    assert.equal((await call("gone")).status, 404);
    assert.equal((await call("limited")).status, 503);
    assert.equal((await call("broken")).status, 502);
  `);
});
