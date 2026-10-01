import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "./database.js";
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

// Which legacy-scope users to retire this run. Revoking a grant kills every
// token the user has issued, so users who also hold a no-scope token are left
// alone (revoking would take out their new token too), and the excess is
// counted in rows because a user can have several.
export function planSunset(
  tokens: PoolTokenScopes[],
  options: { enabled: boolean; healthy: boolean; legacyCap?: number },
): string[] {
  if (!options.enabled || !options.healthy) return [];

  const legacyByUser = new Map<string, PoolTokenScopes[]>();
  const usersWithCleanToken = new Set<string>();
  let cleanRows = 0;
  let legacyRows = 0;
  for (const token of tokens) {
    if (hasLegacyScopes(token.scopes)) {
      legacyRows++;
      if (token.user_id) {
        legacyByUser.set(token.user_id, [
          ...(legacyByUser.get(token.user_id) ?? []),
          token,
        ]);
      }
    } else {
      cleanRows++;
      if (token.user_id) usersWithCleanToken.add(token.user_id);
    }
  }

  const allowedLegacy = Math.max(
    0,
    (options.legacyCap ?? LEGACY_CAP) - cleanRows,
  );
  let excess = legacyRows - allowedLegacy;
  if (excess <= 0) return [];

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
  // The pool is far larger than one observation batch, so the summary is
  // rarely "complete"; require it not to be critical and to have plenty of
  // usable tokens instead.
  const healthy =
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
