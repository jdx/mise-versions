import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { Octokit } from "@octokit/rest";
import { setupDatabase } from "../../../../../../src/database";
import { jsonResponse } from "../../../../lib/api";
import { requireAdminAuth } from "../../../../lib/admin";

interface TokenTestResult {
  id: number;
  user_name: string | null;
  user_id: string | null;
  valid: boolean;
  error?: string;
  rateLimit?: {
    remaining: number;
    limit: number;
    reset: Date;
  };
}

// POST /api/admin/tokens/test - Test all tokens in the pool (admin only)
export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check admin auth (cookie-based)
  const authResult = await requireAdminAuth(request, runtime.env.API_SECRET);
  if (authResult instanceof Response) {
    return authResult;
  }

  const db = drizzle(runtime.env.DB);
  const database = setupDatabase(db);

  // Get all active tokens (includes actual token values)
  const allTokens = await database.getAllTokens();

  const results: TokenTestResult[] = [];

  for (const token of allTokens) {
    try {
      const octokit = new Octokit({ auth: token.token });
      const response = await octokit.rest.users.getAuthenticated();

      // Get rate limit info from response headers
      const rateLimit = {
        remaining: parseInt(
          response.headers["x-ratelimit-remaining"] || "0",
          10,
        ),
        limit: parseInt(response.headers["x-ratelimit-limit"] || "0", 10),
        reset: new Date(
          parseInt(response.headers["x-ratelimit-reset"] || "0", 10) * 1000,
        ),
      };

      // Update validation timestamp
      await database.updateTokenValidation(token.id);

      results.push({
        id: token.id,
        user_name: token.user_name,
        user_id: token.user_id,
        valid: true,
        rateLimit,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      results.push({
        id: token.id,
        user_name: token.user_name,
        user_id: token.user_id,
        valid: false,
        error: errorMessage,
      });
    }
  }

  const validCount = results.filter((r) => r.valid).length;
  const invalidCount = results.filter((r) => !r.valid).length;

  return jsonResponse({
    summary: {
      total: results.length,
      valid: validCount,
      invalid: invalidCount,
    },
    results,
  });
};
