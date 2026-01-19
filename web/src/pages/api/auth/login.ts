import type { APIRoute } from "astro";
import { setOAuthStateCookie, setReturnToCookie } from "../../../lib/auth";

// GET /api/auth/login - Redirect to GitHub OAuth
export const GET: APIRoute = async ({ request, locals, redirect }) => {
  const runtime = locals.runtime;
  const url = new URL(request.url);

  const redirectUri = `${url.origin}/api/auth/callback`;
  const scope = "public_repo";
  const state = crypto.randomUUID();

  // Get return_to from query param (where to go after login)
  const returnTo = url.searchParams.get("return_to") || "/";

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", runtime.env.GITHUB_CLIENT_ID);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthUrl.searchParams.set("scope", scope);
  githubAuthUrl.searchParams.set("state", state);

  // Store state and return_to in cookies
  const headers = new Headers();
  headers.set("Location", githubAuthUrl.toString());
  headers.append("Set-Cookie", setOAuthStateCookie(state));
  headers.append("Set-Cookie", setReturnToCookie(returnTo));

  return new Response(null, {
    status: 302,
    headers,
  });
};
