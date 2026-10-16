#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  DEFAULT_MAX_DAY_LINES,
  capacityAlertEmail,
  capacityLimitsFromEnv,
  capacityMarkdown,
  capacityWarnings,
  jobStartedAtMs,
  reportCapacity,
} from "./logpush-capacity.js";

const MB = 1024 * 1024;
const LIMITS = {
  timeoutMinutes: 90,
  heapLimitMb: 6144,
  runtimeRatio: 0.5,
  rssRatio: 0.5,
  maxDayLines: 100_000_000,
};

function day(overrides = {}) {
  return {
    date: "2026-10-14",
    readMs: 115_000,
    objects: 2059,
    compressedBytes: 1_000 * MB,
    uncompressedBytes: 12_000 * MB,
    lines: 12_900_000,
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    jobElapsedMs: 10 * 60_000,
    peakRssBytes: 1_500 * MB,
    days: [day()],
    ...overrides,
  };
}

const thresholds = (warnings) => warnings.map((w) => w.threshold);

async function captureLog(fn) {
  const logged = [];
  const originalLog = console.log;
  console.log = (msg) => logged.push(msg);
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

const originalFetch = globalThis.fetch;

describe("logpush-capacity", () => {
  let dir;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stays quiet with headroom", () => {
    assert.deepEqual(capacityWarnings(metrics(), LIMITS), []);
  });

  it("warns past half the job timeout", () => {
    // 45 min is exactly half; only going over warns.
    assert.deepEqual(
      capacityWarnings(metrics({ jobElapsedMs: 45 * 60_000 }), LIMITS),
      [],
    );
    const warnings = capacityWarnings(
      metrics({ jobElapsedMs: 46 * 60_000 }),
      LIMITS,
    );
    assert.deepEqual(thresholds(warnings), ["runtime"]);
    assert.match(warnings[0].message, /46\.0 min exceeds 50% of the 90 min/);
  });

  it("warns past half the heap limit", () => {
    const warnings = capacityWarnings(
      metrics({ peakRssBytes: 3_100 * MB }),
      LIMITS,
    );
    assert.deepEqual(thresholds(warnings), ["memory"]);
    assert.match(warnings[0].message, /3,100 MB exceeds 50% of the 6,144 MB/);
  });

  it("warns for each day over the line ceiling", () => {
    const warnings = capacityWarnings(
      metrics({
        days: [
          day({ date: "2026-10-13", lines: 100_000_001 }),
          day({ date: "2026-10-14", lines: 100_000_000 }),
          day({ date: "2026-10-15", lines: 250_000_000 }),
        ],
      }),
      LIMITS,
    );
    assert.deepEqual(thresholds(warnings), ["lines", "lines"]);
    assert.match(warnings[0].message, /^2026-10-13 had 100,000,001 log lines/);
    assert.match(warnings[1].message, /^2026-10-15 had 250,000,000/);
  });

  it("reports every threshold crossed at once", () => {
    const warnings = capacityWarnings(
      metrics({
        jobElapsedMs: 80 * 60_000,
        peakRssBytes: 5_000 * MB,
        days: [day({ lines: 200_000_000 })],
      }),
      LIMITS,
    );
    assert.deepEqual(thresholds(warnings), ["runtime", "memory", "lines"]);
  });

  it("skips the runtime and memory checks without their limits", () => {
    const warnings = capacityWarnings(
      metrics({ jobElapsedMs: 1e9, peakRssBytes: 1e12 }),
      { ...LIMITS, timeoutMinutes: null, heapLimitMb: null },
    );
    assert.deepEqual(warnings, []);
  });

  it("honors custom ratios", () => {
    const limits = { ...LIMITS, runtimeRatio: 0.25, rssRatio: 0.2 };
    assert.deepEqual(
      thresholds(
        capacityWarnings(
          metrics({ jobElapsedMs: 23 * 60_000, peakRssBytes: 1_300 * MB }),
          limits,
        ),
      ),
      ["runtime", "memory"],
    );
  });

  it("reads limits from the environment", () => {
    assert.deepEqual(capacityLimitsFromEnv({}), {
      timeoutMinutes: null,
      heapLimitMb: null,
      runtimeRatio: 0.5,
      rssRatio: 0.5,
      maxDayLines: DEFAULT_MAX_DAY_LINES,
    });
    assert.deepEqual(
      capacityLimitsFromEnv({
        LOGPUSH_TIMEOUT_MINUTES: "90",
        LOGPUSH_HEAP_LIMIT_MB: "6144",
        LOGPUSH_CAPACITY_RUNTIME_RATIO: "0.4",
        LOGPUSH_CAPACITY_RSS_RATIO: "0.6",
        LOGPUSH_CAPACITY_MAX_DAY_LINES: "5e7",
      }),
      {
        timeoutMinutes: 90,
        heapLimitMb: 6144,
        runtimeRatio: 0.4,
        rssRatio: 0.6,
        maxDayLines: 50_000_000,
      },
    );
    // A bad value falls back to the default instead of failing the rollup.
    assert.equal(
      capacityLimitsFromEnv({ LOGPUSH_CAPACITY_RUNTIME_RATIO: "half" })
        .runtimeRatio,
      0.5,
    );
  });

  it("measures runtime from the job start when the workflow passes it", () => {
    assert.equal(
      jobStartedAtMs({ LOGPUSH_JOB_STARTED_AT: "1760400000" }),
      1_760_400_000_000,
    );
    const now = Date.now();
    assert.ok(jobStartedAtMs({}, now) <= now);
  });

  it("renders a markdown table", () => {
    const md = capacityMarkdown(metrics(), LIMITS, []);
    assert.match(
      md,
      /\| 2026-10-14 \| 115\.0 \| 2,059 \| 1,000 \| 12,000 \| 12,900,000 \|/,
    );
    assert.match(md, /No capacity thresholds crossed/);
  });

  it("builds the alert email", () => {
    const email = capacityAlertEmail(
      metrics({
        jobElapsedMs: 50 * 60_000,
        days: [day({ date: "2026-10-13" }), day({ date: "2026-10-14" })],
      }),
      LIMITS,
      [{ threshold: "runtime", message: "job runtime 50.0 min exceeds" }],
      {
        DIGEST_TO: "digest@example.com",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "jdx/mise-versions",
        GITHUB_RUN_ID: "42",
      },
      Date.UTC(2026, 9, 15, 2, 30),
    );
    // Keyed by the day it is sent; the subject names the newest day read.
    assert.equal(
      email.idempotencyKey,
      "mise-versions-logpush-capacity-2026-10-15",
    );
    assert.equal(email.body.from, "mise-tools@en.dev");
    assert.equal(email.body.to, "digest@example.com");
    assert.equal(
      email.body.subject,
      "⚠ mise-versions: Logpush rollup approaching capacity (2026-10-14)",
    );
    assert.match(email.body.text, /job runtime 50\.0 min exceeds/);
    assert.match(email.body.text, /\| 2026-10-13 \| 115\.0 \|/);
    assert.match(
      email.body.text,
      /Run: https:\/\/github\.com\/jdx\/mise-versions\/actions\/runs\/42/,
    );

    const override = capacityAlertEmail(
      metrics({ days: [] }),
      LIMITS,
      [],
      {
        DIGEST_TO: "digest@example.com",
        DIGEST_FROM: "from@example.com",
        CAPACITY_ALERT_TO: "alerts@example.com",
      },
      Date.UTC(2026, 9, 15, 3),
    );
    assert.equal(override.body.to, "alerts@example.com");
    assert.equal(override.body.from, "from@example.com");
    assert.equal(
      override.idempotencyKey,
      "mise-versions-logpush-capacity-2026-10-15",
    );
    assert.doesNotMatch(override.body.text, /Run: /);
    assert.equal(
      capacityAlertEmail(metrics(), LIMITS, [], {}).body.to,
      "mise-tools@mise.jdx.dev",
    );
  });

  it("writes the summary and annotations and emails a warning", async () => {
    dir = mkdtempSync(join(tmpdir(), "logpush-capacity-warning-"));
    const env = {
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      RESEND_API_KEY: "re_test",
      DIGEST_TO: "digest@example.com",
    };
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    };
    const logged = await captureLog(() =>
      reportCapacity(metrics({ jobElapsedMs: 50 * 60_000 }), LIMITS, {
        env,
        now: Date.UTC(2026, 9, 15, 2, 30),
      }),
    );
    assert.match(logged[0], /^capacity: \{/);
    assert.equal(
      JSON.parse(logged[0].slice("capacity: ".length)).days[0].lines,
      12_900_000,
    );
    assert.match(
      logged[1],
      /^::warning title=Logpush rollup approaching capacity::job runtime/,
    );
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /\| Day \|/);
    assert.match(
      readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"),
      /Thresholds crossed/,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.resend.com/emails");
    assert.equal(requests[0].init.headers.Authorization, "Bearer re_test");
    assert.equal(
      requests[0].init.headers["Idempotency-Key"],
      "mise-versions-logpush-capacity-2026-10-15",
    );
    const body = JSON.parse(requests[0].init.body);
    assert.equal(body.to, "digest@example.com");
    assert.match(body.subject, /approaching capacity \(2026-10-14\)/);
  });

  it("annotates a failed send without throwing", async () => {
    globalThis.fetch = async () =>
      new Response("bad key", { status: 401, statusText: "Unauthorized" });
    let warnings;
    const logged = await captureLog(async () => {
      warnings = await reportCapacity(
        metrics({ peakRssBytes: 4_000 * MB }),
        LIMITS,
        { env: { RESEND_API_KEY: "re_bad" }, fetchOptions: { attempts: 1 } },
      );
    });
    assert.deepEqual(thresholds(warnings), ["memory"]);
    assert.match(
      logged.at(-1),
      /^::warning title=Capacity alert email failed::401 Unauthorized/,
    );
  });

  it("sends one email per UTC day whatever dates the runs read", () => {
    const warn = [{ threshold: "lines", message: "too many lines" }];
    const key = (dates, now) =>
      capacityAlertEmail(
        metrics({ days: dates.map((date) => day({ date })) }),
        LIMITS,
        warn,
        {},
        now,
      ).idempotencyKey;
    // The nightly run and a manual backfill of older dates, same UTC day.
    const nightly = key(["2026-10-13", "2026-10-14"], Date.UTC(2026, 9, 15, 2));
    const backfill = key(["2026-10-01"], Date.UTC(2026, 9, 15, 18));
    assert.equal(nightly, backfill);
    // The next UTC day alerts again.
    assert.notEqual(
      key(["2026-10-14", "2026-10-15"], Date.UTC(2026, 9, 16, 2)),
      nightly,
    );
  });

  it("states a failed run accurately in the email", () => {
    const ok = capacityAlertEmail(metrics(), LIMITS, [], {});
    assert.match(ok.body.text, /The run\nsucceeded and wrote its data/);
    const failed = capacityAlertEmail(metrics(), LIMITS, [], {}, Date.now(), {
      ok: false,
      error: "D1 query failed: 503",
    });
    assert.match(failed.body.text, /FAILED: D1 query failed: 503/);
    assert.doesNotMatch(failed.body.text, /succeeded/);
  });

  it("passes the run outcome into the email", async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    };
    await captureLog(() =>
      reportCapacity(metrics({ peakRssBytes: 4_000 * MB }), LIMITS, {
        env: { RESEND_API_KEY: "re_test" },
        outcome: { ok: false, error: "boom" },
      }),
    );
    assert.match(requests[0].text, /FAILED: boom/);
  });

  it("gives up on a send that outlasts its deadline", async () => {
    let aborted = false;
    globalThis.fetch = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal.reason);
        });
      });
    const started = Date.now();
    let warnings;
    const logged = await captureLog(async () => {
      warnings = await reportCapacity(
        metrics({ peakRssBytes: 4_000 * MB }),
        LIMITS,
        {
          env: { RESEND_API_KEY: "re_test" },
          timeoutMs: 50,
          fetchOptions: { baseDelayMs: 2_000 },
        },
      );
    });
    assert.ok(Date.now() - started < 1_000);
    assert.ok(aborted);
    assert.deepEqual(thresholds(warnings), ["memory"]);
    assert.match(
      logged.at(-1),
      /^::warning title=Capacity alert email failed::timed out after 50 ms/,
    );
  });

  it("still annotates and emails when the step summary write fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "logpush-capacity-warning-"));
    let sent = 0;
    globalThis.fetch = async () => {
      sent++;
      return new Response("{}", { status: 200 });
    };
    const logged = await captureLog(() =>
      reportCapacity(metrics({ peakRssBytes: 4_000 * MB }), LIMITS, {
        // A directory, so appending to it throws.
        env: { GITHUB_STEP_SUMMARY: dir, RESEND_API_KEY: "re_test" },
      }),
    );
    assert.ok(
      logged.some((l) =>
        l.startsWith("::warning title=Capacity step summary failed::"),
      ),
    );
    assert.ok(
      logged.some((l) =>
        l.startsWith("::warning title=Logpush rollup approaching capacity::"),
      ),
    );
    assert.equal(sent, 1);
  });

  it("annotates instead of emailing without a Resend key", async () => {
    globalThis.fetch = async () => assert.fail("must not send");
    const logged = await captureLog(() =>
      reportCapacity(metrics({ peakRssBytes: 4_000 * MB }), LIMITS, {
        env: {},
      }),
    );
    assert.match(logged.at(-1), /RESEND_API_KEY is not set/);
  });

  it("sends nothing without a warning or in a dry run", async () => {
    dir = mkdtempSync(join(tmpdir(), "logpush-capacity-warning-"));
    const env = {
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      RESEND_API_KEY: "re_test",
    };
    globalThis.fetch = async () => assert.fail("must not send");
    await captureLog(async () => {
      assert.deepEqual(await reportCapacity(metrics(), LIMITS, { env }), []);
      assert.deepEqual(
        thresholds(
          await reportCapacity(metrics({ peakRssBytes: 4_000 * MB }), LIMITS, {
            env,
            email: false,
          }),
        ),
        ["memory"],
      );
    });
    assert.match(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8"), /No capacity/);
  });
});
