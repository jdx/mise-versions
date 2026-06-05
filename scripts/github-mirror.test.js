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

test("GitHub release mirror follows repository redirects and rewrites asset URLs", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
    } from "./web/src/lib/github/mirror.ts";

    const seen = [];
    const writes = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url) === "https://api.github.com/repos/jdx/rtx/releases/latest") {
        return new Response("Moved Permanently", {
          status: 301,
          headers: {
            Location: "https://api.github.com/repositories/586920414/releases/latest",
          },
        });
      }
      if (String(url) === "https://api.github.com/repositories/586920414/releases/latest") {
        return new Response(JSON.stringify({
          tag_name: "v2026.6.0",
          draft: false,
          prerelease: false,
          created_at: "2026-06-03T18:02:06Z",
          published_at: "2026-06-03T18:02:06Z",
          assets: [{
            name: "install.sh",
            browser_download_url: "https://github.com/jdx/mise/releases/download/v2026.6.0/install.sh",
            url: "https://api.github.com/repos/jdx/mise/releases/assets/437498665",
            digest: "sha256:abc123",
          }],
        }), { status: 200 });
      }
      return new Response("unexpected URL", { status: 500 });
    };

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async (key, value) => writes.push({ key, value }),
      },
    };

    const release = await getCachedGitHubRelease(env, "jdx", "rtx", "latest");

    assert.deepEqual(seen, [
      "https://api.github.com/repos/jdx/rtx/releases/latest",
      "https://api.github.com/repositories/586920414/releases/latest",
    ]);
    assert.equal(release.assets[0].browser_download_url, "https://github.com/jdx/rtx/releases/download/v2026.6.0/install.sh");
    assert.equal(release.assets[0].url, "https://api.github.com/repos/jdx/rtx/releases/assets/437498665");
    assert.equal(writes[0].key, "github:release:jdx/rtx:latest");
  `);
});

test("GitHub release mirror rewrites canonical asset casing to the requested repo", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
    } from "./web/src/lib/github/mirror.ts";

    globalThis.fetch = async (url) => {
      assert.equal(String(url), "https://api.github.com/repos/Dicklesworthstone/Destructive_command_guard/releases/tags/v0.5.6");
      return new Response(JSON.stringify({
        tag_name: "v0.5.6",
        draft: false,
        prerelease: false,
        created_at: "2026-05-27T00:04:32Z",
        published_at: "2026-05-27T00:30:31Z",
        assets: [{
          name: "dcg-aarch64-apple-darwin.tar.xz",
          browser_download_url: "https://github.com/Dicklesworthstone/destructive_command_guard/releases/download/v0.5.6/dcg-aarch64-apple-darwin.tar.xz",
          url: "https://api.github.com/repos/Dicklesworthstone/destructive_command_guard/releases/assets/430632958",
        }],
      }), { status: 200 });
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
      "Dicklesworthstone",
      "Destructive_command_guard",
      "v0.5.6",
    );

    assert.equal(release.assets[0].browser_download_url, "https://github.com/Dicklesworthstone/Destructive_command_guard/releases/download/v0.5.6/dcg-aarch64-apple-darwin.tar.xz");
    assert.equal(release.assets[0].url, "https://api.github.com/repos/Dicklesworthstone/Destructive_command_guard/releases/assets/430632958");
  `);
});

test("GitHub release mirror limits redirect chains", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    let redirects = 0;
    globalThis.fetch = async () =>
      new Response("Moved Permanently", {
        status: 301,
        headers: {
          Location: \`https://api.github.com/repositories/\${++redirects}/releases/latest\`,
        },
      });

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {},
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "latest"),
      (error) => githubStatus(error) === 508,
    );
    assert.equal(redirects, 4);
  `);
});

test("GitHub release mirror rejects unsafe redirects", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

    globalThis.fetch = async () =>
      new Response("Moved Permanently", {
        status: 301,
        headers: {
          Location: "https://example.com/repos/owner/repo/releases/latest",
        },
      });

    const env = {
      DB: {},
      GITHUB_CACHE: {
        get: async () => null,
        put: async () => {},
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "latest"),
      (error) => githubStatus(error) === 502,
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

    const headers = new Headers({ "x-ratelimit-reset": "1780092823" });
    const githubError = new __testing.GitHubError(
      403,
      "rate limited",
      headers,
      "https://api.github.com/repos/cli/cli/releases/latest",
    );
    const azureError = new __testing.GitHubError(
      403,
      "expired SAS token",
      new Headers(),
      "https://tmaproduction.blob.core.windows.net/attestations/1/bundle.json?sig=test",
    );

    assert.equal(__testing.isRateLimited(githubError), true);
    assert.equal(__testing.isRateLimited(azureError), false);
  `);
});
