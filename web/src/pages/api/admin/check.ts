import type { APIRoute } from "astro";
import { getAuthCookie } from "../../../lib/auth";
import { jsonResponse } from "../../../lib/api";
import { isAdmin } from "../../../lib/admin";

// GET /api/admin/check - Check if current user is admin
export const GET: APIRoute = async ({ request, locals }) => {
  const runtime = locals.runtime;
  const auth = await getAuthCookie(request, runtime.env.API_SECRET);

  return jsonResponse({
    isAdmin: auth ? isAdmin(auth.username) : false,
  });
};
