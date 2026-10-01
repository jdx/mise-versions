import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "./database.js";

// A pooled token that GitHub keeps rejecting is already revoked or expired, so
// it is dead weight in the pool (and shows up as "could not be checked").
// Remove tokens that failed with bad credentials on every check for a while.
export const DEAD_TOKEN_CLEANUP_CRON = "23 4 * * *";
export const DEAD_TOKEN_MARKER = "invalid";
export const DEAD_WINDOW_DAYS = 3;
export const DEAD_MIN_CHECKS = 3;
export const DEAD_MIN_SPAN_DAYS = 1;
export const MAX_DEAD_REMOVED_PER_RUN = 100;

// If most recent checks failed, GitHub (or our network) is probably having a
// problem, not every token at once. Don't remove anything then.
export function checksLookHealthy(recent: {
  total: number;
  ok: number;
}): boolean {
  return recent.total > 0 && recent.ok * 2 >= recent.total;
}

export async function cleanupDeadTokens(env: Env): Promise<number> {
  const now = Date.now();
  const since = new Date(now - DEAD_WINDOW_DAYS * 86_400_000).toISOString();
  const lastDay = new Date(now - 86_400_000).toISOString();

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END), 0) AS ok
     FROM token_observations WHERE observed_at >= ?`,
  )
    .bind(lastDay)
    .first<{ total: number; ok: number }>();
  if (!recent || !checksLookHealthy(recent)) {
    console.info("dead_token_cleanup_skipped", { recent });
    return 0;
  }

  const dead = await env.DB.prepare(
    `SELECT o.token_id AS id
     FROM token_observations o
     JOIN tokens t ON t.id = o.token_id
     WHERE o.observed_at >= ?
       AND t.is_active = 1 AND t.token != '' AND t.user_id != 'jdx'
     GROUP BY o.token_id
     HAVING COUNT(*) >= ?
        AND SUM(CASE WHEN o.error LIKE '%Bad credentials%' THEN 1 ELSE 0 END) = COUNT(*)
        AND julianday(MAX(o.observed_at)) - julianday(MIN(o.observed_at)) >= ?
     LIMIT ?`,
  )
    .bind(since, DEAD_MIN_CHECKS, DEAD_MIN_SPAN_DAYS, MAX_DEAD_REMOVED_PER_RUN)
    .all<{ id: number }>();

  const ids = dead.results.map((row) => row.id);
  if (ids.length === 0) return 0;

  await setupDatabase(drizzle(env.DB)).retireTokens(ids, DEAD_TOKEN_MARKER);
  console.info("dead_token_cleanup_removed", { count: ids.length });
  return ids.length;
}
