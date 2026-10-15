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
