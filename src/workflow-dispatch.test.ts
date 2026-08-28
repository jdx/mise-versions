/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  dispatchUpdateWorkflow,
  UPDATE_WORKFLOW_CRON,
} from "./workflow-dispatch.js";

test("dispatches the update workflow on main", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const token = "test-token";

  const result = await dispatchUpdateWorkflow(token, async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return new Response(JSON.stringify({ workflow_run_id: 123 }), {
      status: 200,
      headers: { "x-github-request-id": "request-123" },
    });
  });

  assert.equal(
    requestUrl,
    "https://api.github.com/repos/jdx/mise-versions/actions/workflows/update.yml/dispatches",
  );
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.body, JSON.stringify({ ref: "main" }));
  assert.equal(
    new Headers(requestInit?.headers).get("authorization"),
    `Bearer ${token}`,
  );
  assert.equal(result.requestId, "request-123");
});

test("fails the scheduled event when GitHub rejects the dispatch", async () => {
  await assert.rejects(
    dispatchUpdateWorkflow("bad-token", async () =>
      Promise.resolve(
        new Response(null, {
          status: 401,
          statusText: "Unauthorized",
          headers: { "x-github-request-id": "request-failed" },
        }),
      ),
    ),
    /GitHub workflow dispatch failed: 401 Unauthorized, request request-failed/,
  );
});

test("configures the update dispatch cron in Wrangler", () => {
  const config = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../wrangler.jsonc"),
    "utf8",
  );

  assert.match(
    config,
    new RegExp(`"${UPDATE_WORKFLOW_CRON.replaceAll("*", "\\*")}"`),
  );
});
