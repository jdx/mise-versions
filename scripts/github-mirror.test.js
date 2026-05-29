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

test("GitHub release mirror treats empty assets as a cache miss", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      getCachedGitHubRelease,
      githubStatus,
    } from "./web/src/lib/github/mirror.ts";

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
        put: async () => {
          throw new Error("empty releases should not be cached");
        },
      },
    };

    await assert.rejects(
      () => getCachedGitHubRelease(env, "owner", "repo", "latest"),
      (error) => githubStatus(error) === 404,
    );
  `);
});

test("GitHub attestations hydrate signed blob bundle URLs", () => {
  runMirrorTest(`
    import assert from "node:assert/strict";
    import {
      __testing,
      getCachedGitHubAttestations,
    } from "./web/src/lib/github/mirror.ts";

    const bundleUrl = "https://tmaproduction.blob.core.windows.net/attestations/1/bundle.json?sig=test";
    assert.equal(__testing.validGitHubAttestationBundleUrl(bundleUrl), true);
    assert.equal(__testing.validGitHubAttestationBundleUrl("https://example.com/bundle.json"), false);

    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).startsWith("https://api.github.com/repos/cli/cli/attestations/")) {
        return new Response(JSON.stringify({
          attestations: [{ bundle: null, bundle_url: bundleUrl }],
        }), { status: 200 });
      }
      if (String(url) === bundleUrl) {
        return new Response(JSON.stringify({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" }), { status: 200 });
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

    assert.deepEqual(response.attestations[0].bundle, {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    });
    assert.deepEqual(seen, [
      "https://api.github.com/repos/cli/cli/attestations/sha256%3A02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0?per_page=30",
      bundleUrl,
    ]);
  `);
});
