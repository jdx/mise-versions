// GET /api/token - Get next available token (for update workflow)
import type { Env, PagesContext } from "../_shared";
import { jsonResponse, errorResponse, requireApiAuth, getDb } from "../_shared";
import { setupDatabase } from "../../src/database";
import { Octokit } from "@octokit/rest";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;

  // Require API auth
  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const database = setupDatabase(db);

  // Clean up expired tokens
  await database.deactivateExpiredTokens();

  // Get next available token
  const token = await database.getNextToken();
  if (!token) {
    return errorResponse("No available tokens", 503);
  }

  // Validate token if it hasn't been validated recently
  const lastValidated = token.last_validated ? new Date(token.last_validated) : null;
  const shouldValidate = !lastValidated || Date.now() - lastValidated.getTime() > 24 * 60 * 60 * 1000;

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
        return errorResponse("No valid tokens available", 503);
      }
      Object.assign(token, nextToken);
    }
  }

  return jsonResponse({
    token: token.token,
    installation_id: token.id,
    token_id: token.id,
    expires_at: token.expires_at,
  });
};
