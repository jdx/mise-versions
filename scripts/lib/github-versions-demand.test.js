#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEMAND_BATCH,
  reportGithubVersionsDemand,
} from "./github-versions-demand.js";

describe("reportGithubVersionsDemand", () => {
  it("posts the paths in batches with the day and the API secret", async () => {
    const calls = [];
    const paths = Array.from(
      { length: DEMAND_BATCH + 1 },
      (_, i) => `/data/github/o/r${i}/releases.json`,
    );
    const totals = await reportGithubVersionsDemand({
      apiUrl: "https://example.test",
      secret: "s3cret",
      date: "2026-10-13",
      paths,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, auth: init.headers.Authorization, body });
        return Response.json({ stamped: body.paths.length - 1, unknown: 1 });
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      "https://example.test/api/admin/github/versions/demand",
    );
    assert.equal(calls[0].auth, "Bearer s3cret");
    assert.equal(calls[0].body.date, "2026-10-13");
    assert.equal(calls[0].body.paths.length, DEMAND_BATCH);
    assert.equal(calls[1].body.paths.length, 1);
    assert.deepEqual(totals, {
      paths: DEMAND_BATCH + 1,
      stamped: DEMAND_BATCH - 1,
      unknown: 2,
    });
  });

  it("throws on an HTTP error so the caller can warn", async () => {
    await assert.rejects(
      reportGithubVersionsDemand({
        apiUrl: "https://example.test",
        secret: "s",
        date: "2026-10-13",
        paths: ["/data/github/o/r/releases.json"],
        fetchImpl: async () => new Response("nope", { status: 401 }),
      }),
      /HTTP 401/,
    );
  });
});
