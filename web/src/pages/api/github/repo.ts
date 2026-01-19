import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { Octokit } from "@octokit/rest";
import { setupDatabase } from "../../../../../src/database";
import { getAuthCookie } from "../../../lib/auth";
import { jsonResponse, errorResponse } from "../../../lib/api";

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
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");

  if (!owner || !repo) {
    return errorResponse("Missing owner or repo parameter", 400);
  }

  const cacheKey = `github:${owner}/${repo}`;
  const cached = await runtime.env.GITHUB_CACHE.get<CachedRepoInfo>(
    cacheKey,
    "json",
  );
  const now = Date.now();
  const isFresh = cached && now - cached.cached_at < GITHUB_CACHE_FRESH_MS;

  // If cache is fresh, serve it immediately
  if (cached && isFresh) {
    return jsonResponse({ ...cached.data, stale: false });
  }

  // Check authentication
  const auth = await getAuthCookie(request, runtime.env.API_SECRET);

  // If cache exists but stale, and user is NOT authenticated, serve stale data with warning
  if (cached && !auth) {
    return jsonResponse({ ...cached.data, stale: true });
  }

  // No cache and not authenticated - can't fetch from GitHub
  if (!cached && !auth) {
    return errorResponse("Not authenticated", 401);
  }

  // User is authenticated - try to refresh the cache
  const db = drizzle(runtime.env.DB);
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
    await runtime.env.GITHUB_CACHE.put(cacheKey, JSON.stringify(repoInfo), {
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
};
