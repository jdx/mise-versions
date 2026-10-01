import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { ensureTokenObservabilitySchema } from "../../../../../src/migrations";
import {
  getTokenObservability,
  observeTokenPool,
} from "../../../../../src/token-observability";
import { requireAdminAuth } from "../../../lib/admin";
import { jsonResponse } from "../../../lib/api";

async function authorize(request: Request): Promise<Response | null> {
  const result = await requireAdminAuth(request, env.API_SECRET);
  return result instanceof Response ? result : null;
}

const NO_STORE = { "Cache-Control": "private, no-store" };

// Surface failures as JSON so the admin UI can show the actual cause instead
// of an opaque platform error page.
function failure(action: string, error: unknown): Response {
  console.error(`token-observability ${action} failed:`, error);
  const message = error instanceof Error ? error.message : String(error);
  return jsonResponse({ error: `${action}: ${message}` }, 500, NO_STORE);
}

export const GET: APIRoute = async ({ request }) => {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    await ensureTokenObservabilitySchema(drizzle(env.DB));
    return jsonResponse(await getTokenObservability(env), 200, NO_STORE);
  } catch (error) {
    return failure("load", error);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const authError = await authorize(request);
  if (authError) return authError;

  try {
    await ensureTokenObservabilitySchema(drizzle(env.DB));
    return jsonResponse(await observeTokenPool(env), 200, NO_STORE);
  } catch (error) {
    return failure("check", error);
  }
};
