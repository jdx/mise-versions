import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ack,
  applyChanges,
  bake,
  collectChanges,
  countFiles,
  publishTree,
  readManifest,
  SINCE_MARGIN_MS,
} from "./bake-github-versions.js";

const file = (path, requested_at, body = "{}") => ({
  path,
  requested_at,
  body,
});
const silent = { warn: () => {} };

function dirs() {
  const root = mkdtempSync(join(tmpdir(), "bake-"));
  return {
    root,
    cacheDir: join(root, "cache"),
    assetsDir: join(root, "assets"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A Worker answering /changes from `lists` (path -> { c, b, body, r }).
function fakeWorker(lists, { now = 1_000_000, pageSize = 2 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/changes")) {
      const paths = Object.keys(lists).sort();
      const start = body.cursor ? Number(body.cursor) : 0;
      const page = paths.slice(start, start + pageSize);
      const next =
        start + pageSize < paths.length ? String(start + pageSize) : null;
      const files = [];
      const deleted = [];
      for (const path of page) {
        const list = lists[path];
        if (body.since !== undefined && list.c <= body.since) continue;
        if (list.b) files.push(file(path, list.r ?? list.c, list.body));
        else if (body.since !== undefined) deleted.push(path);
      }
      return Response.json({ files, deleted, cursor: next, now });
    }
    if (url.endsWith("/baked")) return Response.json({ baked: body.watermark });
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

test("a bake without a cache bakes every list and records the watermark", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const worker = fakeWorker({
      "github/a/a/releases.json": { c: 10, b: true, body: '{"a":1}' },
      "github/b/b/tags.json": { c: 20, b: true, body: '{"b":1}' },
      "github/c/c/releases.json": { c: 30, b: false, body: "{}" },
    });
    const result = await bake({
      assetsDir,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
    });
    assert.equal(result.mode, "full");
    assert.equal(result.complete, true);
    assert.equal(result.published, 2);
    assert.equal(result.watermark, 1_000_000);
    // No watermark asked: every baked list.
    assert.ok(worker.calls.every((call) => call.body.since === undefined));
    assert.equal(
      readFileSync(join(assetsDir, "data/github/a/a/releases.json"), "utf8"),
      '{"a":1}',
    );
    assert.ok(existsSync(join(assetsDir, "data/github/b/b/tags.json")));
    assert.ok(!existsSync(join(assetsDir, "data/github/c")));
    const manifest = readManifest(cacheDir);
    assert.equal(manifest.watermark, 1_000_000);
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      "github/a/a/releases.json",
      "github/b/b/tags.json",
    ]);
  } finally {
    cleanup();
  }
});

test("a bake with a cache applies only what changed since its watermark", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const lists = {
      "github/a/a/releases.json": { c: 10, b: true, body: '{"a":1}' },
      "github/b/b/tags.json": { c: 20, b: true, body: '{"b":1}' },
    };
    const first = SINCE_MARGIN_MS + 100;
    let worker = fakeWorker(lists, { now: first });
    await bake({
      assetsDir,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
    });

    // Later: a updated, b removed, d added; the margin re-asks a little.
    const later = first + SINCE_MARGIN_MS + 1000;
    lists["github/a/a/releases.json"] = {
      c: later - 10,
      b: true,
      body: '{"a":2}',
    };
    lists["github/b/b/tags.json"] = { c: later - 5, b: false, body: "{}" };
    lists["github/d/d/releases.json"] = {
      c: later - 1,
      b: true,
      body: '{"d":1}',
    };
    worker = fakeWorker(lists, { now: later });
    const fresh = join(cacheDir, "..", "assets2");
    const result = await bake({
      assetsDir: fresh,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
    });
    assert.equal(result.mode, "incremental");
    assert.equal(result.since, 100);
    assert.ok(worker.calls.every((call) => call.body.since === 100));
    assert.equal(result.written, 2);
    assert.equal(result.removed, 1);
    assert.equal(result.published, 2);
    // A new build directory gets the whole tree, not only the changes.
    assert.equal(
      readFileSync(join(fresh, "data/github/a/a/releases.json"), "utf8"),
      '{"a":2}',
    );
    assert.ok(existsSync(join(fresh, "data/github/d/d/releases.json")));
    assert.ok(!existsSync(join(fresh, "data/github/b/b/tags.json")));
    assert.equal(readManifest(cacheDir).watermark, later);
  } finally {
    cleanup();
  }
});

test("a bake that stops part-way keeps its old watermark", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const worker = fakeWorker(
      {
        "github/a/a/releases.json": { c: 10, b: true },
        "github/b/b/releases.json": { c: 10, b: true },
        "github/c/c/releases.json": { c: 10, b: true },
      },
      { now: 500 },
    );
    await bake({
      assetsDir,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
    });
    assert.equal(readManifest(cacheDir).watermark, 500);

    // The second page fails: what was read is applied, the watermark stays.
    let page = 0;
    const failing = async (url, init) => {
      page++;
      if (page > 1) return new Response("boom", { status: 502 });
      return worker.fetchImpl(url, init);
    };
    const result = await bake({
      assetsDir: join(assetsDir, "..", "x"),
      cacheDir,
      secret: "s",
      fetchImpl: failing,
      log: silent,
    });
    assert.equal(result.complete, false);
    assert.equal(readManifest(cacheDir).watermark, 500);
    assert.equal(result.published, 3);
  } finally {
    cleanup();
  }
});

test("against a Worker without /changes, the old endpoint bakes everything once", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const calls = [];
    const result = await bake({
      assetsDir,
      cacheDir,
      secret: "s",
      log: silent,
      fetchImpl: async (url, init) => {
        calls.push(url);
        if (url.endsWith("/changes"))
          return new Response("nope", { status: 404 });
        const body = JSON.parse(init.body);
        // The previous Worker's bake endpoint, asked not to refresh.
        assert.equal(body.refresh, false);
        return Response.json({
          files: [file("github/a/a/releases.json", 1, '{"legacy":1}')],
          cursor: null,
        });
      },
    });
    assert.equal(result.mode, "legacy");
    assert.equal(result.published, 1);
    assert.deepEqual(
      calls.map((url) => url.split("/").pop()),
      ["changes", "bake"],
    );
    assert.equal(readManifest(cacheDir).watermark, 0);
    assert.equal(
      readFileSync(join(assetsDir, "data/github/a/a/releases.json"), "utf8"),
      '{"legacy":1}',
    );

    // The next deploy updates that tree from the start through /changes,
    // without discarding the lists the refresher has not seen yet.
    const worker = fakeWorker({
      "github/b/b/releases.json": { c: 5, b: true, body: '{"new":1}' },
      "github/c/c/releases.json": { c: 5, b: false },
    });
    const nextDir = join(assetsDir, "..", "next");
    const next = await bake({
      assetsDir: nextDir,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
    });
    assert.equal(next.mode, "incremental");
    assert.equal(next.since, 0);
    assert.equal(next.published, 2);
    assert.ok(existsSync(join(nextDir, "data/github/a/a/releases.json")));
    assert.ok(existsSync(join(nextDir, "data/github/b/b/releases.json")));
  } finally {
    cleanup();
  }
});

test("collectChanges pages, keeps the first page's clock, and stops at the deadline", async () => {
  const worker = fakeWorker(
    {
      "github/a/a/releases.json": { c: 1, b: true },
      "github/b/b/releases.json": { c: 1, b: true },
      "github/c/c/releases.json": { c: 1, b: true },
    },
    { now: 42 },
  );
  const all = await collectChanges({
    secret: "s",
    fetchImpl: worker.fetchImpl,
    log: silent,
  });
  assert.equal(all.pages, 2);
  assert.equal(all.files.length, 3);
  assert.equal(all.watermark, 42);
  assert.equal(all.complete, true);

  const started = Date.now();
  const stalled = await collectChanges({
    secret: "s",
    log: silent,
    deadlineMs: 150,
    fetchImpl: async (_url, init) => {
      if (init.signal.aborted) throw init.signal.reason;
      return new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason)),
      );
    },
  });
  assert.ok(Date.now() - started < 1000, "returned at the deadline");
  assert.equal(stalled.complete, false);
  assert.equal(stalled.files.length, 0);
});

test("the tree keeps only valid paths and publishes the most requested first", () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const { index, invalid } = applyChanges(cacheDir, {
      full: true,
      files: [
        file("github/old/repo/releases.json", 1),
        file("github/new/repo/releases.json", 3),
        file("github/mid/repo/assets/packslip.sigstore.json/releases.json", 2),
        file("github/../../etc/passwd", 9),
        file("github/Up/Case/releases.json", 9),
      ],
    });
    assert.equal(invalid, 2);
    const result = publishTree(cacheDir, { assetsDir, index, maxFiles: 2 });
    assert.deepEqual(result, { published: 2, overCap: 1 });
    assert.ok(
      existsSync(join(assetsDir, "data/github/new/repo/releases.json")),
    );
    assert.ok(!existsSync(join(assetsDir, "data/github/old")));
    assert.equal(countFiles(assetsDir), 2);
  } finally {
    cleanup();
  }
});

test("ack reports the deployed watermark, and nothing without one", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const worker = fakeWorker(
      { "github/a/a/releases.json": { c: 1, b: true } },
      { now: 77 },
    );
    assert.deepEqual(
      await ack({
        secret: "s",
        cacheDir,
        fetchImpl: worker.fetchImpl,
        log: silent,
      }),
      { acked: false },
    );
    await bake({
      assetsDir,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
    });
    const result = await ack({
      secret: "s",
      cacheDir,
      fetchImpl: worker.fetchImpl,
      log: silent,
    });
    assert.deepEqual(result, { acked: true, watermark: 77 });
    const call = worker.calls.at(-1);
    assert.ok(call.url.endsWith("/api/admin/github/versions/baked"));
    assert.deepEqual(call.body, { watermark: 77 });
  } finally {
    cleanup();
  }
});

test("a cached tree is rebuilt from scratch once a week", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const lists = { "github/a/a/releases.json": { c: 10, b: true } };
    const worker = fakeWorker(lists, { now: SINCE_MARGIN_MS + 100 });
    let clock = 1_000_000_000_000;
    const run = (dir) =>
      bake({
        assetsDir: join(assetsDir, "..", dir),
        cacheDir,
        secret: "s",
        fetchImpl: worker.fetchImpl,
        log: silent,
        now: () => clock,
      });
    await run("first");
    // A file left in the tree whose KV entry expired: no removal will come.
    const { index } = applyChanges(cacheDir, {
      files: [file("github/gone/repo/releases.json", 1)],
      index: readManifest(cacheDir).files,
    });
    const manifest = readManifest(cacheDir);
    writeFileSync(
      join(cacheDir, "manifest.json"),
      JSON.stringify({ ...manifest, files: index }),
    );
    clock += 6 * 24 * 60 * 60 * 1000;
    const within = await run("within");
    assert.equal(within.mode, "incremental");
    assert.ok(existsSync(join(assetsDir, "..", "within", "data/github/gone")));
    clock += 2 * 24 * 60 * 60 * 1000;
    const weekly = await run("weekly");
    assert.equal(weekly.mode, "full");
    assert.equal(weekly.published, 1);
    assert.ok(!existsSync(join(assetsDir, "..", "weekly", "data/github/gone")));
  } finally {
    cleanup();
  }
});

test("a rebuild that cannot reach the Worker publishes the tree it has", async () => {
  const { cacheDir, assetsDir, cleanup } = dirs();
  try {
    const worker = fakeWorker(
      { "github/a/a/releases.json": { c: 10, b: true } },
      { now: SINCE_MARGIN_MS + 100 },
    );
    let clock = 1_000_000_000_000;
    await bake({
      assetsDir,
      cacheDir,
      secret: "s",
      fetchImpl: worker.fetchImpl,
      log: silent,
      now: () => clock,
    });
    // A week later the rebuild is due, but every request fails.
    clock += 8 * 24 * 60 * 60 * 1000;
    const out = join(assetsDir, "..", "down");
    const result = await bake({
      assetsDir: out,
      cacheDir,
      secret: "s",
      log: silent,
      now: () => clock,
      fetchImpl: async () => new Response("down", { status: 502 }),
    });
    assert.equal(result.published, 1);
    assert.ok(existsSync(join(out, "data/github/a/a/releases.json")));
    // Still due: the next deploy tries the rebuild again.
    const manifest = readManifest(cacheDir);
    assert.equal(manifest.watermark, SINCE_MARGIN_MS + 100);
    assert.equal(Object.keys(manifest.files).length, 1);
  } finally {
    cleanup();
  }
});
