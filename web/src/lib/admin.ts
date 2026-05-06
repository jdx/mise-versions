// Admin authentication utilities

import { getAuthCookie } from "./auth";
import { errorResponse } from "./api";

const ADMIN_USERNAME = "jdx";

export async function requireAdminAuth(
  request: Request,
  apiSecret: string,
): Promise<Response | { username: string }> {
  const auth = await getAuthCookie(request, apiSecret);

  if (!auth) {
    return errorResponse("Not authenticated", 401);
  }

  if (auth.username !== ADMIN_USERNAME) {
    return errorResponse("Forbidden: Admin access required", 403);
  }

  return auth;
}

export function isAdmin(username: string | null): boolean {
  return username === ADMIN_USERNAME;
}

// Accept either a Bearer API_SECRET (for CLI/external callers) or an admin
// session cookie (for the admin UI). Returns a Response on auth failure.
export async function requireBearerOrAdmin(
  request: Request,
  apiSecret: string,
): Promise<Response | { source: "bearer" | "cookie" }> {
  const authHeader = request.headers.get("Authorization");
  if (authHeader === `Bearer ${apiSecret}`) {
    return { source: "bearer" };
  }

  const auth = await getAuthCookie(request, apiSecret);
  if (auth && isAdmin(auth.username)) {
    return { source: "cookie" };
  }

  return errorResponse("Unauthorized", 401);
}
