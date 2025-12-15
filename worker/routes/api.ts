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

// Cache freshness threshold (6 hours in milliseconds)
const GITHUB_CACHE_FRESH_MS = 6 * 60 * 60 * 1000;
// Cache TTL for KV storage (30 days - we manage freshness ourselves)
const GITHUB_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

interface CachedRepoInfo {
  cached_at: number;
  data: {
    description: string | null;
    homepage: string | null;
    license: string | null;
    stars: number;
    topics: string[];
    forks: number;
    open_issues: number;
    watchers: number;
    pushed_at: string | null;
    created_at: string | null;
    language: string | null;
    archived: boolean;
    default_branch: string;
  };
}

// GET /api/github/repo - Get GitHub repo info (cached, serves stale to unauthenticated)
export async function handleGithubRepo(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");

  if (!owner || !repo) {
    return errorResponse("Missing owner or repo parameter", 400);
  }

  const cacheKey = `github:${owner}/${repo}`;
  const cached = await env.GITHUB_CACHE.get<CachedRepoInfo>(cacheKey, "json");
  const now = Date.now();
  const isFresh = cached && now - cached.cached_at < GITHUB_CACHE_FRESH_MS;

  // If cache is fresh, serve it immediately
  if (cached && isFresh) {
    return jsonResponse({ ...cached.data, stale: false });
  }

  // Check authentication
  const auth = await getAuthCookie(request, env.API_SECRET);

  // If cache exists but stale, and user is NOT authenticated, serve stale data with warning
  if (cached && !auth) {
    return jsonResponse({ ...cached.data, stale: true });
  }

  // No cache and not authenticated - can't fetch from GitHub
  if (!cached && !auth) {
    return errorResponse("Not authenticated", 401);
  }

  // User is authenticated - try to refresh the cache
  const db = getDb(env);
  const database = setupDatabase(db);
  const tokenRecord = await database.getTokenByUserId(auth!.username);

  if (!tokenRecord) {
    // No token but we have stale cache - serve it
    if (cached) {
      return jsonResponse(cached.data);
    }
    return errorResponse("No token found for user", 401);
  }

  try {
    const octokit = new Octokit({ auth: tokenRecord.token });
    const { data } = await octokit.rest.repos.get({ owner, repo });

    const repoInfo: CachedRepoInfo = {
      cached_at: now,
      data: {
        description: data.description,
        homepage: data.homepage,
        license: data.license?.spdx_id ?? null,
        stars: data.stargazers_count,
        topics: data.topics ?? [],
        forks: data.forks_count,
        open_issues: data.open_issues_count,
        watchers: data.subscribers_count,
        pushed_at: data.pushed_at,
        created_at: data.created_at,
        language: data.language,
        archived: data.archived,
        default_branch: data.default_branch,
      },
    };

    // Cache for 30 days (we manage freshness via cached_at)
    await env.GITHUB_CACHE.put(cacheKey, JSON.stringify(repoInfo), {
      expirationTtl: GITHUB_CACHE_TTL_SECONDS,
    });

    return jsonResponse({ ...repoInfo.data, stale: false });
  } catch (error) {
    console.error("GitHub repo fetch error:", error);
    // If fetch fails but we have stale cache, serve it (mark as stale)
    if (cached) {
      return jsonResponse({ ...cached.data, stale: true });
    }
    return errorResponse("Failed to fetch repo info", 500);
  }
}
