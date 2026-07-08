import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { runMigrations } from "../../../../../src/migrations";
import { runAnalyticsMigrations } from "../../../../../src/analytics";
import { jsonResponse, requireApiAuth } from "../../../lib/api";

import { env } from "cloudflare:workers";
// POST /api/admin/migrate - Run database migrations
export const POST: APIRoute = async ({ request }) => {
  // Check API auth
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) {
    return authError;
  }

  await runMigrations(drizzle(env.DB));
  await runAnalyticsMigrations(drizzle(env.ANALYTICS_DB));

  return jsonResponse({ success: true, message: "Migrations completed" });
};
