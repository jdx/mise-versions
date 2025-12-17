import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { Octokit } from '@octokit/rest';
import { setupDatabase } from '../../../../../src/database';
import { jsonResponse, errorResponse, requireApiAuth } from '../../../lib/api';

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

  // Get next available token
  let token = await database.getNextToken();
  if (!token) {
    return errorResponse('No available tokens', 503);
  }

  // Validate token if it hasn't been validated recently
  const lastValidated = token.last_validated
    ? new Date(token.last_validated)
    : null;
  const shouldValidate =
    !lastValidated || Date.now() - lastValidated.getTime() > 24 * 60 * 60 * 1000;

  if (shouldValidate) {
    try {
      const octokit = new Octokit({ auth: token.token });
      await octokit.rest.users.getAuthenticated();
      await database.updateTokenValidation(token.id);
    } catch {
      // Token is invalid, deactivate it and try to get another
      await database.deactivateExpiredTokens();
      console.log(`Deactivated invalid token for user ${token.user_id}`);

      const nextToken = await database.getNextToken();
      if (!nextToken) {
        return errorResponse('No valid tokens available', 503);
      }
      token = nextToken;
    }
  }

  return jsonResponse({
    token: token.token,
    installation_id: token.id,
    token_id: token.id,
    expires_at: token.expires_at,
  });
};
