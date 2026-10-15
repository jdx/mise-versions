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
  import {
    getCachedGitHubDirectory,
    normalizeContentsPath,
    validCommitSha,
  } from "./web/src/lib/github/contents.ts";
  import { githubStatus } from "./web/src/lib/github/mirror.ts";

  const SHA = "6de20f6092dcf9bdb1c8efe03db4b70c82b423dd";
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
`;

test("contents listings keep symlink and submodule types from the tree", () => {
  runMirrorTest(`${PRELUDE}
    reply = () =>
      Response.json({
        sha: SHA,
        truncated: false,
        tree: [
          { path: "Makefile", mode: "100644", type: "blob", sha: "a1", size: 131 },
          { path: "run.sh", mode: "100755", type: "blob", sha: "a2", size: 7 },
          { path: "RelNotes", mode: "120000", type: "blob", sha: "a3", size: 34 },
          { path: "vendor", mode: "160000", type: "commit", sha: "a4" },
          { path: "docs", mode: "040000", type: "tree", sha: "a5" },
        ],
      });

    // Mixed-case SHAs are the same commit.
    const listing = await getCachedGitHubDirectory(
      env, "Owner", "Repo", SHA.toUpperCase(), "src/a b",
    );
    assert.deepEqual(listing.entries, [
      { name: "Makefile", path: "src/a b/Makefile", type: "file", size: 131, sha: "a1" },
      { name: "run.sh", path: "src/a b/run.sh", type: "file", size: 7, sha: "a2" },
      { name: "RelNotes", path: "src/a b/RelNotes", type: "symlink", size: 34, sha: "a3" },
      { name: "vendor", path: "src/a b/vendor", type: "submodule", size: 0, sha: "a4" },
      { name: "docs", path: "src/a b/docs", type: "dir", size: 0, sha: "a5" },
    ]);
    assert.deepEqual(requests, [
      \`https://api.github.com/repos/Owner/Repo/git/trees/\${SHA}:src/a%20b\`,
    ]);
    assert.deepEqual(writes, [
      {
        key: \`github:contents:owner/repo:\${SHA}:src/a b\`,
        options: { expirationTtl: 30 * 24 * 60 * 60 },
      },
    ]);

    // A listing at a commit never changes: served from KV from then on.
    const again = await getCachedGitHubDirectory(env, "owner", "repo", SHA, "src/a b");
    assert.deepEqual(again, listing);
    assert.equal(requests.length, 1);

    // The root is the commit's own tree.
    await getCachedGitHubDirectory(env, "owner", "repo", SHA, "");
    assert.equal(requests[1], \`https://api.github.com/repos/owner/repo/git/trees/\${SHA}\`);
  `);
});

test("contents listings cache files as 400 and missing paths briefly as 404", () => {
  runMirrorTest(`${PRELUDE}
    reply = (url) =>
      url.endsWith(":Makefile")
        ? new Response('{"message":"Invalid object requested."}', { status: 422 })
        : new Response('{"message":"Not Found"}', { status: 404 });

    assert.deepEqual(
      await getCachedGitHubDirectory(env, "owner", "repo", SHA, "Makefile"),
      { status: 400 },
    );
    assert.deepEqual(
      await getCachedGitHubDirectory(env, "owner", "repo", SHA, "nope"),
      { status: 404 },
    );
    assert.deepEqual(
      writes.map((write) => write.options.expirationTtl),
      [30 * 24 * 60 * 60, 30 * 60],
    );
    // Both are answered from KV the second time.
    await getCachedGitHubDirectory(env, "owner", "repo", SHA, "Makefile");
    await getCachedGitHubDirectory(env, "owner", "repo", SHA, "nope");
    assert.equal(requests.length, 2);
  `);
});

test("contents listings never cache a truncated tree or a GitHub failure", () => {
  runMirrorTest(`${PRELUDE}
    reply = () => Response.json({ sha: SHA, truncated: true, tree: [] });
    await assert.rejects(
      () => getCachedGitHubDirectory(env, "owner", "repo", SHA, "big"),
      (error) => githubStatus(error) === 502,
    );
    reply = () => new Response("oops", { status: 500 });
    await assert.rejects(
      () => getCachedGitHubDirectory(env, "owner", "repo", SHA, "big"),
      (error) => githubStatus(error) === 500,
    );
    assert.equal(writes.length, 0);
  `);
});

test("contents listings hash paths too long for a KV key", () => {
  runMirrorTest(`${PRELUDE}
    reply = () => Response.json({ sha: SHA, truncated: false, tree: [] });
    const long = "d".repeat(200) + "/" + "e".repeat(300);
    await getCachedGitHubDirectory(env, "owner", "repo", SHA, long);
    assert.match(
      writes[0].key,
      new RegExp(\`^github:contents-hash:owner/repo:\${SHA}:[0-9a-f]{64}$\`),
    );
  `);
});

test("contents paths and refs are validated", () => {
  runMirrorTest(`${PRELUDE}
    assert.equal(normalizeContentsPath(undefined), "");
    assert.equal(normalizeContentsPath("/"), "");
    assert.equal(normalizeContentsPath("a/b/"), "a/b");
    assert.equal(normalizeContentsPath("a b/.github/c@1.2+x"), "a b/.github/c@1.2+x");
    for (const bad of ["a//b", "a/../b", "./a", "..", "a/\\u0001", "x".repeat(4097)]) {
      assert.equal(normalizeContentsPath(bad), null, bad);
    }
    assert.ok(validCommitSha(SHA));
    assert.ok(validCommitSha(SHA.toUpperCase()));
    for (const bad of [null, "", "main", SHA.slice(1), SHA + "0", "g".repeat(40)]) {
      assert.equal(validCommitSha(bad), false, String(bad));
    }
  `);
});

test("the contents route decodes the path, and checks access before the edge cache", () => {
  runRouteTest(`
    import assert from "node:assert/strict";
    const SHA = "6de20f6092dcf9bdb1c8efe03db4b70c82b423dd";
    const edge = new Map();
    globalThis.caches = {
      default: {
        match: async (request) => edge.get(request.url)?.clone(),
        put: async (request, response) => edge.set(request.url, response),
        delete: async (request) => edge.delete(request.url),
      },
    };
    const requests = [];
    globalThis.fetch = async (url) => {
      url = String(url);
      requests.push(url);
      if (url === "https://api.github.com/repos/owner/repo") {
        return Response.json({ private: false, visibility: "public" });
      }
      if (url === "https://api.github.com/repos/owner/secret") {
        return Response.json({ private: true, visibility: "private" });
      }
      if (url.endsWith(":a%20b")) {
        return Response.json({
          truncated: false,
          tree: [{ path: "c", mode: "100644", type: "blob", sha: "s", size: 1 }],
        });
      }
      return new Response('{"message":"Not Found"}', { status: 404 });
    };
    const kv = new Map();
    globalThis.__env = {
      DB: {},
      ANALYTICS_DB: {},
      GITHUB_CACHE: {
        get: async (key, type) =>
          kv.has(key) ? (type === "json" ? JSON.parse(kv.get(key)) : kv.get(key)) : null,
        put: async (key, value) => kv.set(key, value),
        delete: async (key) => kv.delete(key),
      },
    };
    const { GET } = await import(
      "./web/src/pages/api/github/repos/[owner]/[repo]/contents/[...path].ts"
    );
    const pending = [];
    const url = (repo, path, ref) =>
      "https://mise-versions.jdx.dev/api/github/repos/owner/" + repo +
      "/contents/" + path + "?ref=" + ref;
    const call = (path, ref = SHA, repo = "repo") =>
      GET({
        params: { owner: "owner", repo, path },
        request: new Request(url(repo, path, ref)),
        locals: { cfContext: { waitUntil: (promise) => pending.push(promise) } },
      });

    // Astro leaves the escape in place: a%20b is the directory "a b".
    const response = await call("a%20b");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      { name: "c", path: "a b/c", type: "file", size: 1, sha: "s" },
    ]);
    assert.ok(requests.includes(
      "https://api.github.com/repos/owner/repo/git/trees/" + SHA + ":a%20b",
    ));
    assert.match(response.headers.get("cache-control"), /immutable/);
    await Promise.all(pending);
    assert.equal(edge.size >= 1, true);

    assert.equal((await call("a%2")).status, 400);
    assert.equal((await call("a%20b", "main")).status, 400);
    assert.equal((await call("missing")).status, 404);

    // A private repo is a 404 even with a listing at the edge.
    edge.set(url("secret", "a%20b", SHA), Response.json([]));
    assert.equal((await call("a%20b", SHA, "secret")).status, 404);
    assert.equal(edge.has(url("secret", "a%20b", SHA)), true);
  `);
});
