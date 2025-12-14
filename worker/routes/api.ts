// API routes: /api/*
import {
  Env,
  jsonResponse,
  errorResponse,
  requireApiAuth,
  getAuthCookie,
  getDb,
  CORS_HEADERS,
} from "../shared";
import { setupDatabase } from "../../src/database";
import { getMigrationStatus } from "../../src/migrations";
import { Octokit } from "@octokit/rest";

// GET /api/token - Get next available token (for update workflow)
export async function handleGetToken(
  request: Request,
  env: Env
): Promise<Response> {
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
}

// POST /api/token/rate-limit - Mark a token as rate-limited
export async function handleRateLimitToken(
  request: Request,
  env: Env
): Promise<Response> {
  // Require API auth
  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const database = setupDatabase(db);

  const rateLimitData = (await request.json()) as {
    token_id: number;
    reset_at: string;
  };

  await database.markTokenRateLimited(rateLimitData.token_id, rateLimitData.reset_at);

  return new Response("Token marked as rate-limited", { headers: CORS_HEADERS });
}

// GET /api/stats - Token statistics
export async function handleStats(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const database = setupDatabase(db);
  const stats = await database.getTokenStats();

  return jsonResponse(stats);
}

// GET /api/migrations - Database migration status
export async function handleMigrations(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const migrationStatus = await getMigrationStatus(db);

  return jsonResponse(migrationStatus);
}

// GET /api/rate-limits - Rate limit status across tokens
export async function handleRateLimits(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const database = setupDatabase(db);

  try {
    const allTokens = await database.getAllTokens();
    const rateLimits = [];

    // Check rate limits for each token (limit to first 5 to avoid timeout)
    const tokensToCheck = allTokens.slice(0, 5);

    for (const token of tokensToCheck) {
      try {
        const octokit = new Octokit({ auth: token.token });
        const { data } = await octokit.rest.rateLimit.get();
        rateLimits.push({
          userId: token.user_id,
          userName: token.user_name,
          core: data.resources.core,
          search: data.resources.search,
          graphql: data.resources.graphql,
          lastUsed: token.last_used,
          usageCount: token.usage_count,
        });
      } catch (error) {
        console.log(`Failed to get rate limit for user ${token.user_id}:`, error);
      }
    }

    return jsonResponse({
      totalTokens: allTokens.length,
      checkedTokens: tokensToCheck.length,
      rateLimits,
    });
  } catch (error) {
    console.error("Rate limit check error:", error);
    return errorResponse("Failed to check rate limits", 500);
  }
}

// GET /api/github/repo - Get GitHub repo info (requires user auth)
export async function handleGithubRepo(
  request: Request,
  env: Env
): Promise<Response> {
  const auth = await getAuthCookie(request, env.API_SECRET);
  if (!auth) {
    return errorResponse("Not authenticated", 401);
  }

  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");

  if (!owner || !repo) {
    return errorResponse("Missing owner or repo parameter", 400);
  }

  const db = getDb(env);
  const database = setupDatabase(db);

  const tokenRecord = await database.getTokenByUserId(auth.username);
  if (!tokenRecord) {
    return errorResponse("No token found for user", 401);
  }

  try {
    const octokit = new Octokit({ auth: tokenRecord.token });
    const { data } = await octokit.rest.repos.get({ owner, repo });

    return jsonResponse({
      description: data.description,
      homepage: data.homepage,
      license: data.license?.spdx_id,
      stars: data.stargazers_count,
      topics: data.topics,
    });
  } catch (error) {
    console.error("GitHub repo fetch error:", error);
    return errorResponse("Failed to fetch repo info", 500);
  }
}
