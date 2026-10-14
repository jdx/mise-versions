import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import {
  errorResponse,
  jsonResponse,
  requireApiAuth,
} from "../../../../../lib/api";
import { recordVersionsDemand } from "../../../../../lib/github/versions";

// Each path costs up to a KV read and a write.
const MAX_PATHS = 400;

// POST /api/admin/github/versions/demand
// { date: "YYYY-MM-DD", paths: ["/data/github/cli/cli/releases.json", ...] }
// Requests for baked files never reach the Worker; the nightly Logpush rollup
// reports them here so those lists keep being baked.
export const POST: APIRoute = async ({ request }) => {
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;

  let body: { date?: unknown; paths?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }
  const seenAt =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? Date.parse(`${body.date}T23:59:59Z`)
      : NaN;
  if (!Number.isFinite(seenAt) || seenAt > Date.now() + 24 * 60 * 60 * 1000) {
    return errorResponse(
      "date must be a YYYY-MM-DD day, not in the future",
      400,
    );
  }
  if (
    !Array.isArray(body.paths) ||
    body.paths.length > MAX_PATHS ||
    !body.paths.every((path) => typeof path === "string")
  ) {
    return errorResponse(`paths must be up to ${MAX_PATHS} strings`, 400);
  }
  return jsonResponse(
    await recordVersionsDemand(env, body.paths as string[], seenAt),
  );
};
