import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { Octokit } from '@octokit/rest';
import { setupDatabase } from '../../../../../src/database';
import { jsonResponse, errorResponse, requireApiAuth } from '../../../lib/api';

const MIN_RATE_LIMIT = 1000;

// GET /api/token - Get next available token (for update workflow)
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Require API auth
  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) return authError;

  const db = drizzle(runtime.env.DB);
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
      !lastValidated || Date.now() - lastValidated.getTime() > 24 * 60 * 60 * 1000;

    const octokit = new Octokit({ auth: token.token });

    if (shouldValidate) {
      try {
        await octokit.rest.users.getAuthenticated();
        await database.updateTokenValidation(token.id);
      } catch {
        // Token is invalid, deactivate it and try to get another
        await database.deactivateExpiredTokens();
        console.log(`Deactivated invalid token for user ${token.user_id}`);
        token = await database.getNextToken();
        continue;
      }
    }

    // Check rate limit before returning (doesn't consume quota)
    try {
      const { data } = await octokit.rest.rateLimit.get();
      const remaining = data.resources.core.remaining;

      if (remaining >= MIN_RATE_LIMIT) {
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
      console.log(`Token ${token.id} has ${remaining} remaining, marked rate-limited until ${resetAt}`);
    } catch (e) {
      console.log(`Failed to check rate limit for token ${token.id}:`, e);
      // If rate limit check fails, skip this token
    }

    // Try next token
    token = await database.getNextToken();

    // Avoid infinite loop if we've tried all tokens
    if (token && triedTokenIds.has(token.id)) {
      break;
    }
  }

  return errorResponse('No tokens with sufficient rate limit available', 503);
};
