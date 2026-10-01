import { drizzle } from "drizzle-orm/d1";
import { DEAD_TOKEN_MARKER } from "./dead-token-cleanup.js";
import { setupDatabase } from "./database.js";
import { revokeGrant } from "./github-grant.js";
import { getTokenObservability } from "./token-observability.js";

// Tokens from before sign-in stopped requesting scopes still carry
// `public_repo`, which can write to public repos. We only read, so those are
// retired gradually. The pool is what keeps updates running, so the rule is:
// legacy tokens are capped at LEGACY_CAP minus the number of new no-scope
// tokens. Each new token displaces one legacy token, and the pool never
// shrinks below that cap.
export const LEGACY_SCOPE_SUNSET_CRON = "23 4 * * *";
export const LEGACY_CAP = 1_000;
export const MAX_RETIRED_PER_RUN = 25;
export const MIN_POOL_SIZE_AFTER = 10;
export const MIN_AVAILABLE_TOKENS = 50;

export type PoolTokenScopes = {
  id: number;
  user_id: string | null;
  scopes: string | null;
  created_at: string;
};

export function hasLegacyScopes(scopes: string | null): boolean {
  if (!scopes) return false;
  try {
    const parsed: unknown = JSON.parse(scopes);
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

export type Burndown = {
  cap: number;
  poolRows: number;
  legacyRows: number;
  cleanRows: number;
  legacyUsers: number;
  // Legacy rows the rule currently allows: cap minus new no-scope rows.
  allowedLegacy: number;
  // Legacy rows over what is allowed; this is what the cron works down.
  excess: number;
};

export function computeBurndown(
  tokens: PoolTokenScopes[],
  legacyCap = LEGACY_CAP,
): Burndown {
  let legacyRows = 0;
  let cleanRows = 0;
  const legacyUsers = new Set<string>();
  for (const token of tokens) {
    if (hasLegacyScopes(token.scopes)) {
      legacyRows++;
      if (token.user_id) legacyUsers.add(token.user_id);
    } else {
      cleanRows++;
    }
  }
  const allowedLegacy = Math.max(0, legacyCap - cleanRows);
  return {
    cap: legacyCap,
    poolRows: tokens.length,
    legacyRows,
    cleanRows,
    legacyUsers: legacyUsers.size,
    allowedLegacy,
    excess: Math.max(0, legacyRows - allowedLegacy),
  };
}

// Which legacy-scope users to retire this run. Revoking a grant kills every
// token the user has issued, so users who also hold a no-scope token are left
// alone (revoking would take out their new token too), and the excess is
// counted in rows because a user can have several.
export function planSunset(
  tokens: PoolTokenScopes[],
  options: { enabled: boolean; healthy: boolean; legacyCap?: number },
): string[] {
  if (!options.enabled || !options.healthy) return [];

  let excess = computeBurndown(tokens, options.legacyCap).excess;
  if (excess <= 0) return [];

  const legacyByUser = new Map<string, PoolTokenScopes[]>();
  const usersWithCleanToken = new Set<string>();
  for (const token of tokens) {
    if (!token.user_id) continue;
    if (hasLegacyScopes(token.scopes)) {
      legacyByUser.set(token.user_id, [
        ...(legacyByUser.get(token.user_id) ?? []),
        token,
      ]);
    } else {
      usersWithCleanToken.add(token.user_id);
    }
  }

  const oldestFirst = [...legacyByUser.entries()]
    .filter(([userId]) => !usersWithCleanToken.has(userId))
    .sort(
      ([, a], [, b]) =>
        Math.min(...a.map((t) => Date.parse(t.created_at))) -
        Math.min(...b.map((t) => Date.parse(t.created_at))),
    );

  const chosen: string[] = [];
  let remaining = tokens.length;
  for (const [userId, rows] of oldestFirst) {
    if (excess <= 0 || chosen.length >= MAX_RETIRED_PER_RUN) break;
    if (remaining - rows.length < MIN_POOL_SIZE_AFTER) continue;
    chosen.push(userId);
    remaining -= rows.length;
    excess -= rows.length;
  }
  return chosen;
}

export type BurndownSnapshot = {
  observed_at: string;
  legacy_rows: number;
  clean_rows: number;
  legacy_users: number;
  retired_users: number;
  retired_this_run: number;
  enabled: number;
  healthy: number;
};

async function ensureSnapshotTable(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS legacy_scope_snapshots (
         observed_at TEXT PRIMARY KEY,
         legacy_rows INTEGER NOT NULL,
         clean_rows INTEGER NOT NULL,
         legacy_users INTEGER NOT NULL,
         retired_users INTEGER NOT NULL,
         retired_this_run INTEGER NOT NULL,
         enabled INTEGER NOT NULL,
         healthy INTEGER NOT NULL
       )`,
    )
    .run();
}

// Users whose tokens were retired by the sunset (rows are kept, cleared).
async function countRetiredUsers(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(DISTINCT user_id) AS n FROM tokens WHERE is_active = 0 AND token = ''",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function countDeadRemoved(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM tokens WHERE is_active = 0 AND token = ?",
    )
    .bind(DEAD_TOKEN_MARKER)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function loadBurndown(env: Env) {
  await ensureSnapshotTable(env.DB);
  const pool = await setupDatabase(drizzle(env.DB)).getPoolTokens();
  const history = await env.DB.prepare(
    `SELECT * FROM legacy_scope_snapshots
       ORDER BY observed_at DESC LIMIT 120`,
  ).all<BurndownSnapshot>();
  return {
    current: {
      ...computeBurndown(pool),
      retiredUsers: await countRetiredUsers(env.DB),
      deadRemoved: await countDeadRemoved(env.DB),
    },
    config: {
      enabled: env.LEGACY_SCOPE_SUNSET === "on",
      maxPerRun: MAX_RETIRED_PER_RUN,
      minPoolSize: MIN_POOL_SIZE_AFTER,
      minAvailableTokens: MIN_AVAILABLE_TOKENS,
    },
    history: history.results.reverse(),
  };
}

async function recordSnapshot(
  env: Env,
  details: { enabled: boolean; healthy: boolean; retiredThisRun: number },
): Promise<void> {
  await ensureSnapshotTable(env.DB);
  const pool = await setupDatabase(drizzle(env.DB)).getPoolTokens();
  const burndown = computeBurndown(pool);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO legacy_scope_snapshots
       (observed_at, legacy_rows, clean_rows, legacy_users, retired_users,
        retired_this_run, enabled, healthy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      burndown.legacyRows,
      burndown.cleanRows,
      burndown.legacyUsers,
      await countRetiredUsers(env.DB),
      details.retiredThisRun,
      details.enabled ? 1 : 0,
      details.healthy ? 1 : 0,
    )
    .run();
}

export async function runLegacyScopeSunset(env: Env): Promise<void> {
  const enabled = env.LEGACY_SCOPE_SUNSET === "on";
  let healthy = false;
  let retired = 0;

  try {
    if (!enabled) {
      console.info("legacy_scope_sunset_disabled");
      return;
    }

    const { summary } = await getTokenObservability(env);
    // The pool is far larger than one observation batch, so the summary is
    // rarely "complete"; require it not to be critical and to have plenty of
    // usable tokens instead.
    healthy =
      summary.level !== "critical" &&
      summary.availableTokens >= MIN_AVAILABLE_TOKENS;
    const database = setupDatabase(drizzle(env.DB));
    const pool = await database.getPoolTokens();
    const users = planSunset(pool, { enabled: true, healthy });
    if (users.length === 0) {
      console.info("legacy_scope_sunset_nothing_to_do", {
        healthy,
        poolSize: pool.length,
      });
      return;
    }

    for (const userId of users) {
      const row = pool.find(
        (token) => token.user_id === userId && hasLegacyScopes(token.scopes),
      );
      if (!row) continue;
      try {
        if (!(await revokeGrant(env, row.token))) {
          console.warn("legacy_scope_sunset_revoke_failed", { userId });
          return;
        }
        await database.retireUserTokens(userId);
        retired++;
        console.info("legacy_scope_sunset_retired", { userId });
      } catch (error) {
        console.error("legacy_scope_sunset_error", {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  } finally {
    // Always record a point so the burndown chart has history, even while the
    // sunset is disabled or skipped.
    await recordSnapshot(env, {
      enabled,
      healthy,
      retiredThisRun: retired,
    }).catch((error: unknown) => {
      console.error("legacy_scope_snapshot_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
