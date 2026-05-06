import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { runMaintenancePipeline } from "../../../../../src/maintenance-pipeline";
import { jsonResponse, errorResponse } from "../../../lib/api";
import { requireBearerOrAdmin } from "../../../lib/admin";

// POST /api/admin/scheduled - Run the same maintenance pipeline as the daily
// cron. Accepts either Bearer API_SECRET (for external callers) or an admin
// session cookie (for the admin UI button).
export const POST: APIRoute = async ({ request }) => {
  const auth = await requireBearerOrAdmin(request, env.API_SECRET);
  if (auth instanceof Response) return auth;

  try {
    console.log("Running scheduled tasks...");
    const result = await runMaintenancePipeline(env);
    const failed = result.steps.filter((s) => !s.ok);
    return jsonResponse({
      success: failed.length === 0,
      steps: result.steps,
      failed_count: failed.length,
    });
  } catch (error) {
    console.error("Scheduled task error:", error);
    return errorResponse("Failed to run scheduled tasks", 500);
  }
};
