// GET /api/rate-limits - Rate limit status across tokens
import type { Env, PagesContext } from "../_shared";
import { jsonResponse, errorResponse, requireApiAuth, getDb } from "../_shared";
import { setupDatabase } from "../../src/database";
import { Octokit } from "@octokit/rest";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;

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
};
