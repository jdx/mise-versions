import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  errorResponse,
  jsonResponse,
  requireApiAuth,
} from "../../../../../lib/api";
import { recordVersionsBaked } from "../../../../../lib/github/versions";

// POST /api/admin/github/versions/baked { watermark: number }
// A deploy published the GitHub version lists changed up to `watermark`
// (the `now` of its first changes page). The refresher only dispatches
// deploys for changes after it.
export const POST: APIRoute = async ({ request }) => {
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;

  let body: { watermark?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  if (
    typeof body.watermark !== "number" ||
    !Number.isFinite(body.watermark) ||
    body.watermark > Date.now() + 5 * 60 * 1000
  ) {
    return errorResponse("watermark must be a time, not in the future", 400);
  }
  return jsonResponse({
    baked: await recordVersionsBaked(env, body.watermark),
  });
};
