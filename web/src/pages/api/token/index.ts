import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { Octokit } from "@octokit/rest";
import { setupDatabase } from "../../../../../src/database";
import {
  EMERGENCY_MIN_REMAINING,
  hasBudget,
  hasEmergencyBudget,
} from "../../../../../src/token-budget";
import { alertEmergencyTokenUse } from "../../../../../src/token-observability";
import { jsonResponse, errorResponse, requireApiAuth } from "../../../lib/api";

import { env } from "cloudflare:workers";

// GET /api/token - Get next available token (for update workflow)
export const GET: APIRoute = async ({ request, locals }) => {
  // Require API auth
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;

  const db = drizzle(env.DB);
  const database = setupDatabase(db);

  // Clean up expired tokens
  await database.deactivateExpiredTokens();

  // Try to find a token with sufficient rate limit
  const triedTokenIds = new Set<number>();
  let token = await database.getNextToken();

  while (token) {
    triedTokenIds.add(token.id);

    // Validate token if it hasn't been validated recently
    const lastValidated = token.last_validated
      ? new Date(token.last_validated)
      : null;
    const shouldValidate =
      !lastValidated ||
      Date.now() - lastValidated.getTime() > 24 * 60 * 60 * 1000;

    const octokit = new Octokit({ auth: token.token });

    if (shouldValidate) {
      try {
        await octokit.rest.users.getAuthenticated();
        await database.updateTokenValidation(token.id);
      } catch {
        // Token is invalid, deactivate it and try to get another
        await database.deactivateExpiredTokens();
        console.log(`Deactivated invalid token for user ${token.user_id}`);
        await database.undoCheckout(token.id);
        token = await database.getNextToken();
        continue;
      }
    }

    // Check rate limit before returning (doesn't consume quota)
    try {
      const { data } = await octokit.rest.rateLimit.get();
      const { remaining, limit } = data.resources.core;

      // Leave volunteers' tokens alone once they are running low.
      if (hasBudget(remaining)) {
        // Token has sufficient rate limit, return it
        return jsonResponse({
          token: token.token,
          installation_id: token.id,
          token_id: token.id,
          expires_at: token.expires_at,
          rate_limit_remaining: remaining,
        });
      }

      // Mark token as rate-limited until reset time
      const resetAt = new Date(data.resources.core.reset * 1000).toISOString();
      await database.markTokenRateLimited(token.id, resetAt);
      await database.undoCheckout(token.id);
      console.log(
        `Token ${token.id} has ${remaining}/${limit} remaining (at or below the floor), marked rate-limited until ${resetAt}`,
      );
    } catch (e) {
      console.log(`Failed to check rate limit for token ${token.id}:`, e);
      // If rate limit check fails, skip this token
      await database.undoCheckout(token.id);
    }

    // Try next token
    token = await database.getNextToken();

    // Avoid infinite loop if we've tried all tokens
    if (token && triedTokenIds.has(token.id)) {
      await database.undoCheckout(token.id);
      break;
    }
  }

  // Nothing is above the normal floor. Rather than stall the update job, dip
  // into the pool once more, down to a hard minimum, and tell the maintainer.
  const emergency = await findEmergencyToken(database);
  if (emergency) {
    await database.recordCheckout(emergency.token.id);
    // Best-effort: don't make the update job wait on KV/Resend.
    locals.cfContext.waitUntil(
      alertEmergencyTokenUse(env, {
        tokenId: emergency.token.id,
        remaining: emergency.remaining,
        limit: emergency.limit,
      }),
    );
    return jsonResponse({
      token: emergency.token.token,
      installation_id: emergency.token.id,
      token_id: emergency.token.id,
      expires_at: emergency.token.expires_at,
      rate_limit_remaining: emergency.remaining,
      emergency: true,
    });
  }

  return errorResponse("No tokens with sufficient rate limit available", 503);
};

const EMERGENCY_SCAN_LIMIT = 60;
const EMERGENCY_CANDIDATES = 25;
const EMERGENCY_SCAN_CONCURRENCY = 5;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Token ids whose latest stored observation shows the most requests left, so
// a big pool is searched where the quota actually is instead of by chance.
async function bestObservedTokenIds(): Promise<number[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT o.token_id AS id
       FROM token_observations o
       JOIN (
         SELECT token_id, MAX(observed_at) AS observed_at
         FROM token_observations GROUP BY token_id
       ) latest
         ON latest.token_id = o.token_id AND latest.observed_at = o.observed_at
       WHERE o.error IS NULL AND o.remaining > ?
       ORDER BY o.remaining DESC
       LIMIT ?`,
    )
      .bind(EMERGENCY_MIN_REMAINING, EMERGENCY_CANDIDATES)
      .all<{ id: number }>();
    return rows.results.map((row) => row.id);
  } catch (error) {
    console.warn("emergency candidate lookup failed:", error);
    return [];
  }
}

type PoolToken = Awaited<
  ReturnType<ReturnType<typeof setupDatabase>["getPoolTokens"]>
>[number];
type Candidate = { token: PoolToken; remaining: number; limit: number };

// Live-checks tokens (rate-limit lookups don't use quota) and returns the one
// with the most requests left that is still above the emergency minimum.
async function checkCandidates(tokens: PoolToken[]): Promise<Candidate[]> {
  const found: Candidate[] = [];
  for (let i = 0; i < tokens.length; i += EMERGENCY_SCAN_CONCURRENCY) {
    const batch = tokens.slice(i, i + EMERGENCY_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (token): Promise<Candidate | null> => {
        try {
          const { data } = await new Octokit({
            auth: token.token,
          }).rest.rateLimit.get();
          const { remaining, limit } = data.resources.core;
          return hasEmergencyBudget(remaining)
            ? { token, remaining, limit }
            : null;
        } catch {
          // Invalid or unreachable token: not a candidate.
          return null;
        }
      }),
    );
    found.push(...results.filter((r): r is Candidate => r !== null));
  }
  return found;
}

async function findEmergencyToken(database: ReturnType<typeof setupDatabase>) {
  // 1. Tokens the observer last saw with the most quota, verified live.
  const observed = await database.getPoolTokensByIds(
    await bestObservedTokenIds(),
  );
  const fromObservations = await checkCandidates(observed);
  if (fromObservations.length > 0) {
    return fromObservations.sort((a, b) => b.remaining - a.remaining)[0];
  }

  // 2. Observations missing or stale: sample the pool at random so repeated
  //    calls eventually cover it.
  const sample = shuffle(await database.getPoolTokens()).slice(
    0,
    EMERGENCY_SCAN_LIMIT,
  );
  const fromSample = await checkCandidates(sample);
  return fromSample.sort((a, b) => b.remaining - a.remaining)[0] ?? null;
}
