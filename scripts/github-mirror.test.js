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

test("GitHub release mirror caches empty assets as a short cache miss", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const writes = [];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        tag_name: "v1.0.0",
        draft: false,
        prerelease: false,
        created_at: "2026-01-01T00:00:00Z",
        published_at: "2026-01-01T00:00:00Z",
        assets: [],
      }), { status: 200 });

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value, options) => writes.push({ key, value, options }),
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "latest"),
      (error) => githubStatus(error) === 404,
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, "github:release:owner/repo:latest");
    assert.deepEqual(writes[0].options, { expirationTtl: 1800 });
    assert.equal(JSON.parse(writes[0].value).data.immutable, false);
  `);
});

test("GitHub release mirror follows API redirects", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { getCachedGitHubRelease } from "./web/src/lib/github/mirror.ts";

    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url) === "https://api.github.com/repos/StackExchange/dnscontrol/releases/tags/v4.41.0") {
        return new Response("", {
          status: 301,
          headers: {
            Location: "https://api.github.com/repos/StackExchange/dnscontrol2/releases/tags/v4.41.0",
          },
        });
      }
      if (String(url) === "https://api.github.com/repos/StackExchange/dnscontrol2/releases/tags/v4.41.0") {
        return new Response(JSON.stringify({
          tag_name: "v4.41.0",
          draft: false,
          prerelease: false,
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-01T00:00:00Z",
          assets: [{
            name: "dnscontrol.tar.gz",
            browser_download_url: "https://github.com/StackExchange/dnscontrol2/releases/download/v4.41.0/dnscontrol.tar.gz",
            url: "https://api.github.com/repos/StackExchange/dnscontrol2/releases/assets/1",
          }],
        }), { status: 200 });
      }
      return new Response("unexpected URL", { status: 500 });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {},
      },
    };

    const release = await getCachedGitHubRelease(
      env,
      "StackExchange",
      "dnscontrol",
      "v4.41.0",
    );

    assert.equal(release.tag_name, "v4.41.0");
    assert.deepEqual(seen, [
      "https://api.github.com/repos/StackExchange/dnscontrol/releases/tags/v4.41.0",
      "https://api.github.com/repos/StackExchange/dnscontrol2/releases/tags/v4.41.0",
    ]);
  `);
});

test("GitHub release mirror trusts explicit upstream immutable releases", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { getCachedGitHubRelease } from "./web/src/lib/github/mirror.ts";

    const writes = [];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        tag_name: "v1.0.0",
        draft: false,
        prerelease: false,
        immutable: true,
        created_at: "2026-01-01T00:00:00Z",
        published_at: "2099-01-01T00:00:00Z",
        assets: [{
          name: "tool.tar.gz",
          browser_download_url: "https://github.com/owner/repo/releases/download/v1.0.0/tool.tar.gz",
          url: "https://api.github.com/repos/owner/repo/releases/assets/1",
        }],
      }), { status: 200 });

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value, options) => writes.push({ key, value, options }),
      },
    };

    const release = await getCachedGitHubRelease(env, "owner", "repo", "v1.0.0");

    assert.equal(release.immutable, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].options, undefined);
  `);
});

test("GitHub release mirror trusts explicit upstream mutable releases", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { getCachedGitHubRelease } from "./web/src/lib/github/mirror.ts";

    const writes = [];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({
        tag_name: "v1.0.0",
        draft: false,
        prerelease: false,
        immutable: false,
        created_at: "2026-01-01T00:00:00Z",
        published_at: "2026-01-01T00:00:00Z",
        assets: [{
          name: "tool.tar.gz",
          browser_download_url: "https://github.com/owner/repo/releases/download/v1.0.0/tool.tar.gz",
          url: "https://api.github.com/repos/owner/repo/releases/assets/1",
        }],
      }), { status: 200 });

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value, options) => writes.push({ key, value, options }),
      },
    };

    const release = await getCachedGitHubRelease(env, "owner", "repo", "v1.0.0");

    assert.equal(release.immutable, false);
    assert.deepEqual(writes[0].options, { expirationTtl: 2592000 });
  `);
});

test("GitHub release mirror rejects redirects outside the GitHub API", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response("", {
        status: 302,
        headers: {
          Location: "https://example.com/repos/owner/repo/releases/tags/v1.0.0",
        },
      });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {},
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "v1.0.0"),
      (error) => githubStatus(error) === 502,
    );
    assert.deepEqual(seen, [
      "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0",
    ]);
  `);
});

test("GitHub release mirror rejects redirect loops", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const seen = [];
    globalThis.fetch = async (url) => {
      const current = String(url);
      seen.push(current);
      const redirect = Number(new URL(current).searchParams.get("redirect") ?? "0");
      return new Response("", {
        status: 302,
        headers: {
          Location:
            redirect < 3
              ? "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0?redirect=" + (redirect + 1)
              : "https://example.com/should-not-be-resolved",
        },
      });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {},
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "v1.0.0"),
      (error) =>
        githubStatus(error) === 502 &&
        error.message === "GitHub API redirect limit exceeded",
    );
    assert.deepEqual(seen, [
      "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0",
      "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0?redirect=1",
      "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0?redirect=2",
      "https://api.github.com/repos/owner/repo/releases/tags/v1.0.0?redirect=3",
    ]);
  `);
});

test("GitHub release mirror negative-caches upstream 404s", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    const writes = [];
    const deletes = [];
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response("not found", { status: 404 });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value, options) => writes.push({ key, value, options }),
        delete: async (key) => deletes.push(key),
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "v404.0.0"),
      (error) => githubStatus(error) === 404,
    );

    assert.equal(fetches, 1);
    assert.deepEqual(deletes, []);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, "github:release-error:owner/repo:v404.0.0");
    assert.deepEqual(writes[0].options, { expirationTtl: 1800 });
    assert.equal(JSON.parse(writes[0].value).data.status, 404);
  `);
});

test("GitHub release mirror does not serve stale positive cache after upstream 404", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response("not found", { status: 404 });
    };

    const writes = [];
    const deletes = [];
    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async (key) => {
          if (key === "github:release:owner/repo:v1.0.0") {
            return {
              cached_at: Date.now() - 7 * 60 * 60 * 1000,
              data: {
                tag_name: "v1.0.0",
                draft: false,
                prerelease: false,
                created_at: "2026-01-01T00:00:00Z",
                immutable: false,
                assets: [{
                  name: "tool.tar.gz",
                  browser_download_url: "https://github.com/owner/repo/releases/download/v1.0.0/tool.tar.gz",
                  url: "https://api.github.com/repos/owner/repo/releases/assets/1",
                }],
              },
            };
          }
          return null;
        },
        put: async (key, value, options) => writes.push({ key, value, options }),
        delete: async (key) => deletes.push(key),
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "v1.0.0"),
      (error) => githubStatus(error) === 404,
    );

    assert.equal(fetches, 1);
    assert.deepEqual(deletes, ["github:release:owner/repo:v1.0.0"]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].key, "github:release-error:owner/repo:v1.0.0");
  `);
});

test("GitHub release mirror serves fresh negative cache without fetching", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response("unexpected fetch", { status: 500 });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async (key) => {
          if (key === "github:release-error:owner/repo:v404.0.0") {
            return {
              cached_at: Date.now(),
              data: { status: 404, message: "Not found" },
            };
          }
          return null;
        },
        put: async () => {
          throw new Error("negative cache hit should not write");
        },
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "v404.0.0"),
      (error) => githubStatus(error) === 404,
    );

    assert.equal(fetches, 0);
  `);
});

test("GitHub release mirror ignores stale negative cache without deleting it", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
    } from "./web/src/lib/github/mirror.ts";

    let fetches = 0;
    globalThis.fetch = async () => {
      fetches++;
      return new Response(JSON.stringify({
        tag_name: "v1.0.0",
        draft: false,
        prerelease: false,
        created_at: "2026-01-01T00:00:00Z",
        published_at: "2026-01-01T00:00:00Z",
        assets: [{
          name: "tool.tar.gz",
          browser_download_url: "https://github.com/owner/repo/releases/download/v1.0.0/tool.tar.gz",
          url: "https://api.github.com/repos/owner/repo/releases/assets/1",
        }],
      }), { status: 200 });
    };

    const deletes = [];
    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async (key) => {
          if (key === "github:release-error:owner/repo:v1.0.0") {
            return {
              cached_at: Date.now() - 31 * 60 * 1000,
              data: { status: 404, message: "Not found" },
            };
          }
          return null;
        },
        put: async () => {},
        delete: async (key) => deletes.push(key),
      },
    };

    const release = await getCachedGitHubRelease(env, "owner", "repo", "v1.0.0");

    assert.equal(fetches, 1);
    assert.equal(release.tag_name, "v1.0.0");
    assert.deepEqual(deletes, []);
  `);
});

test("GitHub release mirror uses status-specific negative cache TTLs", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    async function ttlForStatus(status) {
      const writes = [];
      globalThis.fetch = async () => new Response("failure", { status });
      const env = {
        DB: {},
        GITHUB_CACHE: {
          get: async () => null,
          put: async (key, value, options) => writes.push({ key, value, options }),
        },
      };
      await assert.rejects(
        () => getCachedGitHubRelease(env, "owner", "repo", "v" + status),
        (error) => githubStatus(error) === status,
      );
      return writes[0].options.expirationTtl;
    }

    assert.equal(await ttlForStatus(500), 60);
    assert.equal(await ttlForStatus(401), 300);
    assert.equal(await ttlForStatus(403), 300);
  `);
});

test("GitHub release mirror does not negative-cache rate-limited 403s", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    async function writesForHeaders(headers) {
      const writes = [];
      globalThis.fetch = async () =>
        new Response("rate limited", { status: 403, headers });

      const env = {
        DB: {},
        GITHUB_CACHE: {
          get: async () => null,
          put: async (key, value, options) => writes.push({ key, value, options }),
        },
      };

      await assert.rejects(
        () => getCachedGitHubRelease(env, "owner", "repo", "v403.0.0"),
        (error) => githubStatus(error) === 403,
      );
      return writes;
    }

    assert.equal(
      (await writesForHeaders({ "x-ratelimit-reset": "1780092823" })).length,
      0,
    );
    assert.equal((await writesForHeaders({ "retry-after": "60" })).length, 0);
  `);
});

test("GitHub release mirror preserves upstream error when negative-cache write fails", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    globalThis.fetch = async () => new Response("not found", { status: 404 });

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {
          throw new Error("KV write failed");
        },
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "v404.0.0"),
      (error) => githubStatus(error) === 404,
    );
  `);
});

test("GitHub attestations hydrate signed blob bundle URLs without GitHub tokens", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      __testing,
      getCachedGitHubAttestations,
    } from "./web/src/lib/github/mirror.ts";
    import { compress } from "snappyjs";

    const bundleUrl = "https://tmaproduction.blob.core.windows.net/attestations/1/bundle.json?sig=test";
    const bundle = { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" };
    const compressedBundle = compress(
      new TextEncoder().encode(JSON.stringify(bundle)),
    );
    const token = { id: 1, token: "secret-github-token" };
    assert.equal(__testing.validGitHubAttestationBundleUrl(bundleUrl), true);
    assert.equal(__testing.validGitHubAttestationBundleUrl("https://example.com/bundle.json"), false);
    assert.equal(__testing.isGitHubApiUrl("https://api.github.com/repos/cli/cli"), true);
    assert.equal(__testing.isGitHubApiUrl(bundleUrl), false);
    assert.equal(
      __testing.githubJsonHeaders("https://api.github.com/repos/cli/cli", token).Authorization,
      "Bearer secret-github-token",
    );
    assert.equal(
      __testing.githubJsonHeaders(bundleUrl, token).Authorization,
      undefined,
    );

    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({
        url: String(url),
        authorization: init?.headers?.Authorization,
      });
      if (String(url).startsWith("https://api.github.com/repos/cli/cli/attestations/")) {
        return new Response(JSON.stringify({
          attestations: [{ bundle: null, bundle_url: bundleUrl }],
        }), { status: 200 });
      }
      if (String(url) === bundleUrl) {
        return new Response(compressedBundle, {
          status: 200,
          headers: { "Content-Type": "application/x-snappy" },
        });
      }
      return new Response("unexpected URL", { status: 500 });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {},
      },
    };

    const response = await getCachedGitHubAttestations(
      env,
      "cli",
      "cli",
      "sha256:02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0",
    );

    assert.deepEqual(response.attestations[0].bundle, bundle);
    assert.deepEqual(seen, [
      {
        url: "https://api.github.com/repos/cli/cli/attestations/sha256%3A02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0?per_page=30",
        authorization: undefined,
      },
      {
        url: bundleUrl,
        authorization: undefined,
      },
    ]);
  `);
});

test("GitHub rate limiting only applies to GitHub API responses", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import { __testing } from "./web/src/lib/github/mirror.ts";

    const resetHeaders = new Headers({ "x-ratelimit-reset": "1780092823" });
    const retryAfterHeaders = new Headers({ "retry-after": "60" });
    const retryAfterDateHeaders = new Headers({
      "retry-after": "Sat, 06 Jun 2026 23:00:00 GMT",
    });
    const githubError = new __testing.GitHubError(
      403,
      "rate limited",
      resetHeaders,
      "https://api.github.com/repos/cli/cli/releases/latest",
    );
    const secondaryLimitError = new __testing.GitHubError(
      403,
      "secondary rate limit",
      retryAfterHeaders,
      "https://api.github.com/repos/cli/cli/releases/latest",
    );
    const secondaryLimitDateError = new __testing.GitHubError(
      403,
      "secondary rate limit",
      retryAfterDateHeaders,
      "https://api.github.com/repos/cli/cli/releases/latest",
    );
    const azureError = new __testing.GitHubError(
      403,
      "expired SAS token",
      new Headers(),
      "https://tmaproduction.blob.core.windows.net/attestations/1/bundle.json?sig=test",
    );
    const githubForbidden = new __testing.GitHubError(
      403,
      "forbidden",
      new Headers(),
      "https://api.github.com/repos/cli/cli/releases/latest",
    );

    assert.equal(__testing.isRateLimited(githubError), true);
    assert.equal(__testing.isRateLimited(secondaryLimitError), true);
    assert.equal(__testing.isRateLimited(secondaryLimitDateError), true);
    assert.equal(__testing.isRateLimited(azureError), false);
    assert.equal(__testing.isRateLimited(githubForbidden), false);
    assert.equal(__testing.resetAt(githubError), "2026-05-29T22:13:43.000Z");
    assert.equal(
      __testing.resetAt(secondaryLimitDateError),
      "2026-06-06T23:00:00.000Z",
    );
  `);
});
