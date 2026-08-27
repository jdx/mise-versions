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

export const GET: APIRoute = async ({ request }) => {
  const authError = await authorize(request);
  if (authError) return authError;

  await ensureTokenObservabilitySchema(drizzle(env.DB));
  return jsonResponse(await getTokenObservability(env), 200, {
    "Cache-Control": "private, no-store",
  });
};

export const POST: APIRoute = async ({ request }) => {
  const authError = await authorize(request);
  if (authError) return authError;

  await ensureTokenObservabilitySchema(drizzle(env.DB));
  return jsonResponse(await observeTokenPool(env), 200, {
    "Cache-Control": "private, no-store",
  });
};
