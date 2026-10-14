import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  errorResponse,
  jsonResponse,
  requireApiAuth,
} from "../../../../../lib/api";
import { listVersionsChanges } from "../../../../../lib/github/versions";

// POST /api/admin/github/versions/changes
// { since?: number, cursor?: string, limit?: number }
// One page of the GitHub version lists changed (or no longer baked) since
// `since`, or every baked list without it, for
// scripts/bake-github-versions.js. Reads KV only: no GitHub requests.
export const POST: APIRoute = async ({ request }) => {
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;

  let body: { since?: unknown; cursor?: unknown; limit?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const since =
    typeof body.since === "number" && Number.isFinite(body.since)
      ? body.since
      : undefined;
  const cursor = typeof body.cursor === "string" ? body.cursor : undefined;
  const limit =
    typeof body.limit === "number" && Number.isInteger(body.limit)
      ? body.limit
      : undefined;
  return jsonResponse(await listVersionsChanges(env, { since, cursor, limit }));
};
