import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadBurndown } from "../../../../../src/legacy-scope-sunset";
import { requireAdminAuth } from "../../../lib/admin";
import { errorResponse, jsonResponse } from "../../../lib/api";

// GET /api/admin/legacy-tokens - Burndown of tokens that still carry scopes
export const GET: APIRoute = async ({ request }) => {
  const auth = await requireAdminAuth(request, env.API_SECRET);
  if (auth instanceof Response) return auth;

  try {
    return jsonResponse(await loadBurndown(env), 200, {
      "Cache-Control": "private, no-store",
    });
  } catch (error) {
    console.error("Legacy token burndown error:", error);
    return errorResponse("Failed to load legacy token burndown", 500);
  }
};
