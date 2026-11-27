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

  it("sends batches concurrently, up to the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen = [];
    const paths = Array.from(
      { length: DEMAND_BATCH * 6 },
      (_, i) => `/data/github/o/r${String(i).padStart(5, "0")}/releases.json`,
    );
    const totals = await reportGithubVersionsDemand({
      apiUrl: "https://example.test",
      secret: "s",
      date: "2026-10-13",
      paths,
      concurrency: 4,
      fetchImpl: async (_url, init) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        const body = JSON.parse(init.body);
        seen.push(...body.paths);
        return Response.json({ stamped: body.paths.length, unknown: 0 });
      },
    });
    assert.equal(peak, 4);
    assert.deepEqual(seen.sort(), [...paths].sort());
    assert.deepEqual(totals, {
      paths: paths.length,
      stamped: paths.length,
      unknown: 0,
    });
  });

  it("stops sending batches after one fails", async () => {
    let calls = 0;
    await assert.rejects(
      reportGithubVersionsDemand({
        apiUrl: "https://example.test",
        secret: "s",
        date: "2026-10-13",
        paths: Array.from(
          { length: DEMAND_BATCH * 10 },
          (_, i) => `/data/github/o/r${i}/releases.json`,
        ),
        concurrency: 2,
        fetchImpl: async () => {
          calls++;
          return new Response("nope", { status: 500 });
        },
      }),
      /HTTP 500/,
    );
    assert.equal(calls, 2);
  });

  it("waits for batches in flight, then rejects with a network error", async () => {
    let calls = 0;
    let settled = 0;
    await assert.rejects(
      reportGithubVersionsDemand({
        apiUrl: "https://example.test",
        secret: "s",
        date: "2026-10-13",
        paths: Array.from(
          { length: DEMAND_BATCH * 10 },
          (_, i) => `/data/github/o/r${i}/releases.json`,
        ),
        concurrency: 3,
        fetchImpl: async () => {
          const call = ++calls;
          if (call === 1) throw new TypeError("fetch failed");
          await new Promise((resolve) => setTimeout(resolve, 10));
          settled++;
          return Response.json({ stamped: 0, unknown: 0 });
        },
      }),
      /fetch failed/,
    );
    // The two batches already in flight finished; no new ones started.
    assert.equal(calls, 3);
    assert.equal(settled, 2);
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
