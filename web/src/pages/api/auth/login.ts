import type { APIRoute } from "astro";
import {
  newOAuthState,
  setOAuthStateCookie,
  setReturnToCookie,
} from "../../../lib/auth";

import { env } from "cloudflare:workers";
// GET /api/auth/login - Redirect to GitHub OAuth
export const GET: APIRoute = async ({ request, locals, redirect }) => {
  const url = new URL(request.url);

  const redirectUri = `${url.origin}/api/auth/callback`;
  const state = newOAuthState();

  // Get return_to from query param (where to go after login)
  const returnTo = url.searchParams.get("return_to") || "/";

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  // No scope: we only read public data, which needs no permissions. A token
  // with no scopes cannot write to anything.
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
