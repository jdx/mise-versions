// Helpers for endpoints whose response depends on who is signed in. Responses
// are never shareable: the edge cache must not serve one user's data to
// another, and anonymous visitors must always get a fresh 401.
import { getAuthCookie } from "./auth";

export function privateJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function requireSession(
  request: Request,
  secret: string,
): Promise<{ username: string } | Response> {
  const auth = await getAuthCookie(request, secret);
  if (!auth?.username) {
    return privateJson({ error: "Sign in with GitHub to see this" }, 401);
  }
  return { username: auth.username };
}

// State-changing requests must be JSON. A cross-site form cannot send that
// content type without a CORS preflight, which these endpoints never approve.
export function isJsonRequest(request: Request): boolean {
  return (request.headers.get("Content-Type") || "").startsWith(
    "application/json",
  );
}
