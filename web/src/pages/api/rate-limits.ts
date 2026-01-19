import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { Octokit } from "@octokit/rest";
import { setupDatabase } from "../../../../src/database";
import { jsonResponse, errorResponse, requireApiAuth } from "../../lib/api";

// GET /api/rate-limits - Rate limit status across tokens (admin)
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) return authError;

  const db = drizzle(runtime.env.DB);
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
        console.log(
          `Failed to get rate limit for user ${token.user_id}:`,
          error,
        );
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
