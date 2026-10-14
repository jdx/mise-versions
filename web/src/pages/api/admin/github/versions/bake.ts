import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  errorResponse,
  jsonResponse,
  requireApiAuth,
} from "../../../../../lib/api";
import { bakeVersionsPage } from "../../../../../lib/github/versions";

// Longest a page may spend refreshing lists before it bakes the rest as
// stored; keeps each call well inside a request's limits.
const MAX_REFRESH_MS = 20 * 1000;

// POST /api/admin/github/versions/bake
// { cursor?: string, limit?: number, refresh?: boolean }
// One page of the stored GitHub version lists as files for
// scripts/bake-github-versions.js to write into the deploy's static assets.
export const POST: APIRoute = async ({ request }) => {
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;

  let body: { cursor?: unknown; limit?: unknown; refresh?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
  const limit =
    typeof body.limit === "number" && Number.isInteger(body.limit)
      ? body.limit
      : 100;
  const refresh = body.refresh !== false;

  const page = await bakeVersionsPage(env, {
    cursor,
    limit,
    refreshUntil: refresh ? Date.now() + MAX_REFRESH_MS : 0,
  });
  return jsonResponse(page);
};
