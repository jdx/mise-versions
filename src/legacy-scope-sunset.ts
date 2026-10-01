import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "./database.js";
import { getTokenObservability } from "./token-observability.js";

// Tokens from before sign-in stopped requesting scopes still carry
// `public_repo`, which can write to public repos. We only read, so those are
// retired gradually: a few per day, only while the pool is healthy and never
// below a minimum size, because the pool is what keeps updates running.
export const LEGACY_SCOPE_SUNSET_CRON = "23 4 * * *";
export const MAX_RETIRED_PER_RUN = 2;
export const MIN_POOL_SIZE_AFTER = 10;

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

// Which legacy-scope users to retire this run. A user can have several token
// rows and revoking their grant kills all of them, so the budget is in users
// and the pool-size check counts every row that would go.
export function planSunset(
  tokens: PoolTokenScopes[],
  options: { enabled: boolean; healthy: boolean },
): string[] {
  if (!options.enabled || !options.healthy) return [];

  const legacyByUser = new Map<string, PoolTokenScopes[]>();
  for (const token of tokens) {
    if (!token.user_id || !hasLegacyScopes(token.scopes)) continue;
    legacyByUser.set(token.user_id, [
      ...(legacyByUser.get(token.user_id) ?? []),
      token,
    ]);
  }

  const oldestFirst = [...legacyByUser.entries()].sort(
    ([, a], [, b]) =>
      Math.min(...a.map((t) => Date.parse(t.created_at))) -
      Math.min(...b.map((t) => Date.parse(t.created_at))),
  );

  const chosen: string[] = [];
  let remaining = tokens.length;
  for (const [userId, rows] of oldestFirst) {
    if (chosen.length >= MAX_RETIRED_PER_RUN) break;
    if (remaining - rows.length < MIN_POOL_SIZE_AFTER) continue;
    chosen.push(userId);
    remaining -= rows.length;
  }
  return chosen;
}

// Deleting the grant revokes every token the user has issued to the app.
async function revokeGrant(env: Env, accessToken: string): Promise<boolean> {
  const response = await fetch(
    `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "mise-versions",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    },
  );
  await response.body?.cancel();
  // 404 means the grant is already gone, which is what we wanted.
  return response.status === 204 || response.status === 404;
}

export async function runLegacyScopeSunset(env: Env): Promise<void> {
  if (env.LEGACY_SCOPE_SUNSET !== "on") {
    console.info("legacy_scope_sunset_disabled");
    return;
  }

  const { summary } = await getTokenObservability(env);
  const healthy = summary.level === "healthy" && summary.complete;
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
      console.info("legacy_scope_sunset_retired", { userId });
    } catch (error) {
      console.error("legacy_scope_sunset_error", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
  }
}
