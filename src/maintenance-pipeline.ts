// Shared maintenance pipeline run by both the daily cron (src/worker.ts)
// and the admin "Run Scheduled Tasks" button (api/admin/scheduled.ts).
//
// Each step is isolated with per-step error capture so a single failure
// (e.g. D1 overload during MAU computation) does not cascade. The MAU step
// is intentionally bounded — a full 31-day recompute issues 31 × ~5M-row
// UNION queries which overwhelm D1; we only refresh today + yesterday plus
// a handful of oldest missing days, so the historical gap heals over
// successive runs without overloading the database.

import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { runMigrations } from "./migrations.js";
import { runAnalyticsMigrations, setupAnalytics } from "./analytics/index.js";

const ROLLUP_BACKFILL_DAYS = 31;
const MAU_BACKFILL_GAP_LIMIT = 3;

interface PipelineEnv {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
}

export interface StepResult {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

export interface PipelineResult {
  steps: StepResult[];
}

export async function runMaintenancePipeline(
  env: PipelineEnv,
): Promise<PipelineResult> {
  const db = drizzle(env.DB);
  await runMigrations(db);

  const analyticsDb = drizzle(env.ANALYTICS_DB);
  await runAnalyticsMigrations(analyticsDb);

  const analytics = setupAnalytics(analyticsDb);
  const now = new Date();
  const steps: StepResult[] = [];

  await runStep(steps, "aggregate", async () => {
    const r = await analytics.aggregateOldData();
    return `${r.aggregated} groups aggregated, ${r.deleted} rows deleted`;
  });

  await runDailyBackfill(steps, "rollup", now, ROLLUP_BACKFILL_DAYS, (d) =>
    analytics.populateRollupTables(d, env.ANALYTICS_DB),
  );

  await runDailyBackfill(
    steps,
    "version-stats",
    now,
    ROLLUP_BACKFILL_DAYS,
    (d) => analytics.populateVersionStatsRollup(d, env.ANALYTICS_DB),
  );

  await runStep(steps, "mau", async () => {
    const targets = await pickMauTargets(
      analyticsDb,
      now,
      ROLLUP_BACKFILL_DAYS,
      MAU_BACKFILL_GAP_LIMIT,
    );
    let ok = 0;
    const failures: string[] = [];
    for (const date of targets) {
      try {
        await analytics.populateDailyMauStats(date, env.ANALYTICS_DB);
        ok++;
      } catch (e) {
        failures.push(`${date}: ${errMsg(e)}`);
        console.error(`populateDailyMauStats failed for ${date}:`, e);
      }
    }
    if (failures.length) {
      throw new Error(
        `refreshed ${ok}/${targets.length} (failures: ${failures.join("; ")})`,
      );
    }
    return `refreshed ${ok}/${targets.length} (${targets.join(", ")})`;
  });

  await runStep(steps, "download-summaries", async () => {
    const s = await analytics.populateToolDownloadSummaries(env.ANALYTICS_DB);
    return `${s.toolSummaries} tools, ${s.platformSummaries} platforms, ${s.versionSummaries} versions`;
  });

  await runStep(steps, "backend-summaries", async () => {
    const s = await analytics.populateBackendToolSummaries(env.ANALYTICS_DB);
    return `${s.backendSummaries} rows`;
  });

  await runStep(steps, "trending-summaries", async () => {
    const s = await analytics.populateTrendingToolSummaries(env.ANALYTICS_DB);
    return `${s.trendingSummaries} tools`;
  });

  return { steps };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function runStep(
  out: StepResult[],
  name: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    const detail = await fn();
    console.log(`[${name}] ok: ${detail}`);
    out.push({ name, ok: true, detail });
  } catch (e) {
    console.error(`[${name}] failed:`, e);
    out.push({ name, ok: false, error: errMsg(e) });
  }
}

async function runDailyBackfill(
  out: StepResult[],
  name: string,
  now: Date,
  days: number,
  fn: (dateStr: string) => Promise<unknown>,
): Promise<void> {
  await runStep(out, name, async () => {
    let ok = 0;
    const failures: string[] = [];
    // Process recent days first so today/yesterday land before any per-
    // invocation limit kicks in. Older days are best-effort backfill.
    for (let i = 0; i < days; i++) {
      const dateStr = dateStrAgo(now, i);
      try {
        await fn(dateStr);
        ok++;
      } catch (e) {
        failures.push(`${dateStr}: ${errMsg(e)}`);
        console.error(`${name} failed for ${dateStr}:`, e);
      }
    }
    if (failures.length) {
      throw new Error(`${ok}/${days} days (${failures.length} failures)`);
    }
    return `${ok}/${days} days`;
  });
}

function dateStrAgo(now: Date, daysAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split("T")[0];
}

// Pick the dates we need to (re)compute MAU for: today + yesterday always
// (user-visible), then the oldest missing days in the lookback window. We
// cap the total work to keep D1 below its overload threshold.
async function pickMauTargets(
  analyticsDb: ReturnType<typeof drizzle>,
  now: Date,
  lookbackDays: number,
  gapBackfillLimit: number,
): Promise<string[]> {
  const today = dateStrAgo(now, 0);
  const yesterday = dateStrAgo(now, 1);
  const oldest = dateStrAgo(now, lookbackDays - 1);

  const present = await analyticsDb.all<{ date: string }>(sql`
    SELECT date
    FROM daily_mau_stats
    WHERE date >= ${oldest} AND date <= ${today}
  `);
  const have = new Set(present.map((r) => r.date));

  const targets = new Set<string>([today, yesterday]);
  let added = 0;
  for (let i = lookbackDays - 1; i >= 2 && added < gapBackfillLimit; i--) {
    const date = dateStrAgo(now, i);
    if (!have.has(date) && !targets.has(date)) {
      targets.add(date);
      added++;
    }
  }
  return [...targets].sort();
}
