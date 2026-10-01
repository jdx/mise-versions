import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "../../../../../src/database";
import { getAuthCookie, type AuthStatusResponse } from "../../../lib/auth";

import { env } from "cloudflare:workers";
// GET /api/auth/me - Check current login state
export const GET: APIRoute = async ({ request, locals }) => {
  const auth = await getAuthCookie(request, env.API_SECRET);

  let lookups: number | undefined;
  if (auth) {
    try {
      lookups = (
        await setupDatabase(drizzle(env.DB)).getUsageForUser(auth.username)
      ).lookups;
    } catch (error) {
      console.error("Usage lookup failed", error);
    }
  }

  const response: AuthStatusResponse = auth
    ? { authenticated: true, username: auth.username, lookups }
    : { authenticated: false };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
