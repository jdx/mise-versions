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

// Constant-time string comparison to avoid leaking the secret's prefix
// through response-time side channels. Returns false immediately on length
// mismatch — that's acceptable here because the header format ("Bearer …")
// fixes the length and an attacker already knows it.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// Accept either a Bearer API_SECRET (for CLI/external callers) or an admin
// session cookie (for the admin UI). Returns a Response on auth failure.
export async function requireBearerOrAdmin(
  request: Request,
  apiSecret: string,
): Promise<Response | { source: "bearer" | "cookie" }> {
  const authHeader = request.headers.get("Authorization");
  if (apiSecret && authHeader && safeEqual(authHeader, `Bearer ${apiSecret}`)) {
    return { source: "bearer" };
  }

  const adminAuth = await requireAdminAuth(request, apiSecret);
  if (adminAuth instanceof Response) return adminAuth;
  return { source: "cookie" };
}
