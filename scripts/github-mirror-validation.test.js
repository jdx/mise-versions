import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runValidationTest(source) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-"],
    {
      cwd: new URL("..", import.meta.url),
      input: source,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
}

test("validReleaseTag accepts npm-style aqua release tags", () => {
  runValidationTest(`
    import assert from "node:assert/strict";
    import { validReleaseTag } from "./web/src/lib/github/mirror.ts";

    assert.equal(validReleaseTag("@biomejs/biome@2.4.16"), true);
    assert.equal(validReleaseTag("@moonrepo/cli@1.0.0"), true);
    assert.equal(validReleaseTag("@yarnpkg/cli/4.0.0"), true);
  `);
});

test("validReleaseTag accepts common GitHub release tags", () => {
  runValidationTest(`
    import assert from "node:assert/strict";
    import { validReleaseTag } from "./web/src/lib/github/mirror.ts";

    assert.equal(validReleaseTag("v1.0.0"), true);
    assert.equal(validReleaseTag("latest"), true);
    assert.equal(validReleaseTag("release/2026"), true);
  `);
});

test("validReleaseTag rejects empty and unsafe values", () => {
  runValidationTest(`
    import assert from "node:assert/strict";
    import { validReleaseTag } from "./web/src/lib/github/mirror.ts";

    assert.equal(validReleaseTag(undefined), false);
    assert.equal(validReleaseTag(""), false);
    assert.equal(validReleaseTag("tag with spaces"), false);
    assert.equal(validReleaseTag("tag?query=1"), false);
  `);
});
