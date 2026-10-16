/**
 * Capacity metrics for the nightly Logpush rollup, and the thresholds that
 * warn before it outgrows its GitHub Actions job: the job timeout, the Node
 * heap limit, and a ceiling on log lines per day.
 *
 * The rollup records what each day cost (read/parse time, objects, bytes,
 * lines) plus the run's peak RSS and job runtime, prints them, and checks them
 * against the limits here. Crossing a threshold never fails the rollup: it
 * emits `::warning::` annotations and emails jdx through Resend (the daily
 * digest's sender and recipient), once per day.
 */

import { appendFileSync } from "node:fs";
import { DEFAULT_FROM, DEFAULT_TO } from "../daily-digest.js";
import { fetchWithRetry } from "./fetch-with-retry.js";

export const CAPACITY_WARNING_TITLE = "Logpush rollup approaching capacity";

// About 3x a full day of traffic in October 2026 (~33M lines).
export const DEFAULT_MAX_DAY_LINES = 100_000_000;
export const DEFAULT_RUNTIME_RATIO = 0.5;
export const DEFAULT_RSS_RATIO = 0.5;

function positiveNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    // A typo in a threshold must not fail the rollup.
    console.warn(`${name} must be a positive number, got ${raw}; ignoring it`);
    return fallback;
  }
  return value;
}

// Limits from the environment. The job timeout and heap limit have no default:
// without them the matching check is skipped rather than compared against a
// guess that could drift from the workflow.
export function capacityLimitsFromEnv(env = process.env) {
  return {
    timeoutMinutes: positiveNumber(env, "LOGPUSH_TIMEOUT_MINUTES", null),
    heapLimitMb: positiveNumber(env, "LOGPUSH_HEAP_LIMIT_MB", null),
    runtimeRatio: positiveNumber(
      env,
      "LOGPUSH_CAPACITY_RUNTIME_RATIO",
      DEFAULT_RUNTIME_RATIO,
    ),
    rssRatio: positiveNumber(
      env,
      "LOGPUSH_CAPACITY_RSS_RATIO",
      DEFAULT_RSS_RATIO,
    ),
    maxDayLines: positiveNumber(
      env,
      "LOGPUSH_CAPACITY_MAX_DAY_LINES",
      DEFAULT_MAX_DAY_LINES,
    ),
  };
}

// When the job started, in ms since the epoch: LOGPUSH_JOB_STARTED_AT (unix
// seconds, written by the workflow's first step) so checkout and tool setup
// count too, or else when this process started.
export function jobStartedAtMs(env = process.env, now = Date.now()) {
  const seconds = Number(env.LOGPUSH_JOB_STARTED_AT);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return now - process.uptime() * 1000;
}

// Peak resident set size of this process so far, in bytes.
export function peakRssBytes() {
  return process.resourceUsage().maxRSS * 1024;
}

const MB = 1024 * 1024;
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const fmtMinutes = (ms) => (ms / 60_000).toFixed(1);
const fmtMb = (bytes) => fmtInt(bytes / MB);
const pct = (ratio) => `${Math.round(ratio * 100)}%`;

/**
 * Pure threshold check.
 *
 * @param {{jobElapsedMs: number, peakRssBytes: number,
 *          days: Array<{date: string, lines: number}>}} metrics
 * @param {ReturnType<typeof capacityLimitsFromEnv>} limits
 * @returns {Array<{threshold: string, message: string}>}
 */
export function capacityWarnings(metrics, limits) {
  const warnings = [];
  if (limits.timeoutMinutes) {
    const budgetMs = limits.timeoutMinutes * 60_000 * limits.runtimeRatio;
    if (metrics.jobElapsedMs > budgetMs) {
      warnings.push({
        threshold: "runtime",
        message: `job runtime ${fmtMinutes(metrics.jobElapsedMs)} min exceeds ${pct(limits.runtimeRatio)} of the ${limits.timeoutMinutes} min job timeout (${fmtMinutes(budgetMs)} min)`,
      });
    }
  }
  if (limits.heapLimitMb) {
    const budgetBytes = limits.heapLimitMb * MB * limits.rssRatio;
    if (metrics.peakRssBytes > budgetBytes) {
      warnings.push({
        threshold: "memory",
        message: `peak RSS ${fmtMb(metrics.peakRssBytes)} MB exceeds ${pct(limits.rssRatio)} of the ${fmtInt(limits.heapLimitMb)} MB heap limit (${fmtMb(budgetBytes)} MB)`,
      });
    }
  }
  for (const day of metrics.days) {
    if (day.lines > limits.maxDayLines) {
      warnings.push({
        threshold: "lines",
        message: `${day.date} had ${fmtInt(day.lines)} log lines, over the ${fmtInt(limits.maxDayLines)} line ceiling`,
      });
    }
  }
  return warnings;
}

// Markdown for the step summary and the alert email.
export function capacityMarkdown(metrics, limits, warnings) {
  const rows = metrics.days.map(
    (day) =>
      `| ${day.date} | ${(day.readMs / 1000).toFixed(1)} | ${fmtInt(day.objects)} | ${fmtMb(day.compressedBytes)} | ${fmtMb(day.uncompressedBytes)} | ${fmtInt(day.lines)} |`,
  );
  const limit = (value, fmt) => (value ? fmt(value) : "not set");
  const lines = [
    "### Logpush rollup capacity",
    "",
    "| Day | Read/parse (s) | Objects | Compressed (MB) | Uncompressed (MB) | Lines |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    `- Job runtime: ${fmtMinutes(metrics.jobElapsedMs)} min (warn above ${limit(limits.timeoutMinutes, (m) => `${pct(limits.runtimeRatio)} of ${m} min`)})`,
    `- Peak RSS: ${fmtMb(metrics.peakRssBytes)} MB (warn above ${limit(limits.heapLimitMb, (m) => `${pct(limits.rssRatio)} of ${fmtInt(m)} MB`)})`,
    `- Line ceiling per day: ${fmtInt(limits.maxDayLines)}`,
    "",
  ];
  if (warnings.length > 0) {
    lines.push(
      "**Thresholds crossed:**",
      "",
      ...warnings.map((w) => `- ${w.message}`),
      "",
    );
  } else {
    lines.push("No capacity thresholds crossed.", "");
  }
  return lines.join("\n");
}

function runUrl(env) {
  return env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    : null;
}

// The day an alert is about: the newest day the run read, or today when it
// read none (a run that died before finishing a day).
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function alertDate(metrics, now) {
  const dates = metrics.days.map((day) => day.date).sort();
  return dates.at(-1) ?? utcDay(now);
}

/**
 * The Resend payload for a capacity alert. Sender and recipient follow the
 * daily digest (DIGEST_FROM / DIGEST_TO); CAPACITY_ALERT_TO overrides the
 * recipient. The idempotency key is the UTC calendar day the alert is sent
 * (`now`), not the day it is about, so any number of runs on one day (the
 * nightly run, a rerun, a manual backfill of other dates) send at most one
 * email. Resend keeps idempotency keys for about 24 hours, which covers a day.
 */
// How the run ended, in words for the alert email.
function outcomeText(outcome) {
  if (outcome?.ok === false) {
    return [
      "The nightly Logpush rollup crossed a capacity threshold, and the run",
      `FAILED: ${outcome.error ?? "unknown error"}`,
      "Days without a row in the table below were not written; rerun them",
      "with the maintenance workflow's refresh-logpush task.",
    ];
  }
  return [
    "The nightly Logpush rollup crossed a capacity threshold. The run",
    "succeeded and wrote its data; this is an early warning before traffic",
    "growth makes the job run out of time or memory.",
  ];
}

export function capacityAlertEmail(
  metrics,
  limits,
  warnings,
  env = process.env,
  now = Date.now(),
  outcome = { ok: true },
) {
  const date = alertDate(metrics, now);
  const url = runUrl(env);
  const markdown = capacityMarkdown(metrics, limits, warnings);
  const text = [
    ...outcomeText(outcome),
    "",
    markdown,
    url ? `Run: ${url}` : null,
    "",
    "Thresholds are set in the logpush job of .github/workflows/maintenance.yml.",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
  return {
    idempotencyKey: `mise-versions-logpush-capacity-${utcDay(now)}`,
    body: {
      from: env.DIGEST_FROM || DEFAULT_FROM,
      to: env.CAPACITY_ALERT_TO || env.DIGEST_TO || DEFAULT_TO,
      subject: `⚠ mise-versions: ${CAPACITY_WARNING_TITLE} (${date})`,
      text,
    },
  };
}

// The whole send (request, retries, response body) gets this long.
export const ALERT_SEND_TIMEOUT_MS = 15_000;

async function sendCapacityAlert(email, env, fetchOptions, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const send = async () => {
    const response = await fetchWithRetry(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": email.idempotencyKey,
        },
        body: JSON.stringify(email.body),
        signal,
      },
      { attempts: 2, baseDelayMs: 1000, ...fetchOptions },
    );
    return response.json();
  };
  // The signal aborts the request in flight; the race also ends a retry
  // backoff that would otherwise run past the deadline.
  const deadline = new Promise((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error(`timed out after ${timeoutMs} ms`)),
      { once: true },
    );
  });
  const body = await Promise.race([send(), deadline]);
  console.log(`Sent capacity alert email ${body.id ?? "(no id)"}`);
}

const annotation = (title, message) =>
  console.log(
    `::warning title=${title}::${String(message).replace(/[\r\n]+/g, " ")}`,
  );

/**
 * Print the metrics, write the step summary, and on a warning emit
 * `::warning::` annotations and email jdx through Resend (unless `email` is
 * false, as in a dry run). `outcome` is how the rollup ended,
 * `{ ok: true }` or `{ ok: false, error }`. Each part fails on its own, and
 * none of them throws: capacity reporting must not fail the rollup.
 */
export async function reportCapacity(
  metrics,
  limits,
  {
    env = process.env,
    email = true,
    outcome = { ok: true },
    fetchOptions,
    timeoutMs = ALERT_SEND_TIMEOUT_MS,
    now = Date.now(),
  } = {},
) {
  let warnings;
  try {
    warnings = capacityWarnings(metrics, limits);
    console.log(
      `capacity: ${JSON.stringify({ ...metrics, limits, outcome, warnings })}`,
    );
  } catch (error) {
    console.warn("Capacity check failed:", error);
    return [];
  }
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(
        env.GITHUB_STEP_SUMMARY,
        `${capacityMarkdown(metrics, limits, warnings)}\n`,
      );
    } catch (error) {
      annotation("Capacity step summary failed", error?.message ?? error);
    }
  }
  for (const warning of warnings) {
    annotation(CAPACITY_WARNING_TITLE, warning.message);
  }
  if (warnings.length === 0 || !email) return warnings;
  if (!env.RESEND_API_KEY) {
    annotation("Capacity alert not emailed", "RESEND_API_KEY is not set");
    return warnings;
  }
  try {
    await sendCapacityAlert(
      capacityAlertEmail(metrics, limits, warnings, env, now, outcome),
      env,
      fetchOptions,
      timeoutMs,
    );
  } catch (error) {
    annotation("Capacity alert email failed", error?.message ?? error);
  }
  return warnings;
}
