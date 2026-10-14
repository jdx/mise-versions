import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collectBakedFiles,
  countFiles,
  writeBakedFiles,
} from "./bake-github-versions.js";

const file = (path, requested_at, body = "{}") => ({
  path,
  requested_at,
  body,
});
const silent = { warn: () => {} };

test("collectBakedFiles pages through the bake endpoint", async () => {
  const bodies = [];
  const pages = [
    {
      files: [file("github/a/a/releases.json", 1)],
      cursor: "c1",
      stats: { listed: 2, refreshed: 1, unrequested: 1 },
      outOfTokens: false,
    },
    {
      files: [file("github/b/b/tags.json", 2)],
      cursor: null,
      stats: { listed: 1, deferred: 1 },
      outOfTokens: true,
    },
  ];
  const result = await collectBakedFiles({
    apiUrl: "https://example.test",
    secret: "s3cret",
    log: silent,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://example.test/api/admin/github/versions/bake");
      assert.equal(init.headers.Authorization, "Bearer s3cret");
      bodies.push(JSON.parse(init.body));
      return Response.json(pages[bodies.length - 1]);
    },
  });
  assert.deepEqual(bodies, [
    { limit: 100, refresh: true },
    { cursor: "c1", limit: 100, refresh: true },
  ]);
  assert.equal(result.files.length, 2);
  assert.equal(result.complete, true);
  assert.equal(result.outOfTokens, true);
  assert.equal(result.totals.refreshed, 1);
  assert.equal(result.totals.deferred, 1);
  assert.equal(result.totals.pages, 2);
});

test("collectBakedFiles stops refreshing when out of time or tokens, and stops paging on errors", async () => {
  let clock = 0;
  const refreshes = [];
  const result = await collectBakedFiles({
    secret: "s",
    log: silent,
    refreshMs: 1000,
    deadlineMs: 5000,
    now: () => clock,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      refreshes.push(body.refresh);
      clock += 600;
      if (refreshes.length === 3) return new Response("boom", { status: 502 });
      if (refreshes.length === 4) throw new Error("network");
      return Response.json({
        files: [file(`github/o/r${refreshes.length}/releases.json`, 1)],
        cursor: `c${refreshes.length}`,
        stats: {},
        outOfTokens: false,
      });
    },
  });
  // Page 2 starts after 600ms (refreshing), page 3 after 1200ms (not).
  // Page 3 fails twice (502, then a network error): stop with what we have.
  assert.deepEqual(refreshes, [true, true, false, false]);
  assert.equal(result.files.length, 2);
  assert.equal(result.complete, false);
});

test("writeBakedFiles keeps the most recently requested files under the cap", () => {
  const dir = mkdtempSync(join(tmpdir(), "bake-"));
  try {
    const result = writeBakedFiles(
      [
        file("github/old/repo/releases.json", 1, '{"old":true}'),
        file("github/new/repo/releases.json", 3, '{"new":true}'),
        file("github/mid/repo/assets/packslip.sigstore.json/releases.json", 2),
        // Never outside data/github/, never uppercase.
        file("github/../../etc/passwd", 9),
        file("github/Up/Case/releases.json", 9),
      ],
      { assetsDir: dir, maxFiles: 2 },
    );
    assert.deepEqual(result, { written: 2, invalid: 2, overCap: 1 });
    assert.equal(
      readFileSync(join(dir, "data/github/new/repo/releases.json"), "utf8"),
      '{"new":true}',
    );
    assert.ok(
      existsSync(
        join(
          dir,
          "data/github/mid/repo/assets/packslip.sigstore.json/releases.json",
        ),
      ),
    );
    assert.ok(!existsSync(join(dir, "data/github/old")));
    assert.equal(countFiles(dir), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectBakedFiles cancels a stalled request at the deadline", async () => {
  const started = Date.now();
  const result = await collectBakedFiles({
    secret: "s",
    log: silent,
    deadlineMs: 150,
    fetchImpl: async (_url, init) => {
      if (init.signal.aborted) throw init.signal.reason;
      // The first page answers; the second never does.
      if (!init.body.includes("c1")) {
        return Response.json({
          files: [file("github/o/r/releases.json", 1)],
          cursor: "c1",
          stats: {},
          outOfTokens: false,
        });
      }
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      );
    },
  });
  assert.ok(Date.now() - started < 1000, "returned at the deadline");
  assert.equal(result.files.length, 1);
  assert.equal(result.complete, false);
});
