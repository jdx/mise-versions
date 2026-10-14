import { test } from "node:test";
import assert from "node:assert/strict";
import { isMiseCiRequest, isMiseCiUserAgent } from "./mise-client";
import { hashIP } from "./hash";

const UA = "mise/2026.10.10 linux-x64 (2026-10-11) bash";

test("CI is marked by the x-mise-ci header or a trailing ci token", () => {
  assert.equal(isMiseCiUserAgent(UA), false);
  assert.equal(isMiseCiUserAgent(`${UA} ci`), true);
  assert.equal(isMiseCiUserAgent("curl/8 ci"), false);
  assert.equal(isMiseCiUserAgent(null), false);

  const request = (headers: Record<string, string>) =>
    new Request("https://mise-versions.jdx.dev/t", { headers });
  assert.equal(isMiseCiRequest(request({ "user-agent": UA })), false);
  assert.equal(isMiseCiRequest(request({ "user-agent": `${UA} ci` })), true);
  assert.equal(
    isMiseCiRequest(request({ "user-agent": UA, "x-mise-ci": "true" })),
    true,
  );
});

test("hashIP matches the Logpush rollup's hash (scripts/lib/logpush.js)", async () => {
  assert.equal(await hashIP("203.0.113.1", "test-secret"), "5076d4960826");
});
