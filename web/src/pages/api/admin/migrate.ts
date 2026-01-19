import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { runAnalyticsMigrations } from "../../../../../src/analytics";
import { jsonResponse, requireApiAuth } from "../../../lib/api";

// POST /api/admin/migrate - Run database migrations
export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;

  // Check API auth
  const authError = requireApiAuth(request, runtime.env.API_SECRET);
  if (authError) {
    return authError;
  }

  const db = drizzle(runtime.env.ANALYTICS_DB);
  await runAnalyticsMigrations(db);

  return jsonResponse({ success: true, message: "Migrations completed" });
};
