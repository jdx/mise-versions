import type { APIRoute } from "astro";
import { createOAuthUserAuth } from "@octokit/auth-oauth-user";
import { Octokit } from "@octokit/rest";
import { drizzle } from "drizzle-orm/d1";
import { setupDatabase } from "../../../../../src/database";
import { revokeGrant } from "../../../../../src/github-grant";
import { env } from "cloudflare:workers";
import {
  getOAuthStateCookie,
  isFreshOAuthState,
  clearOAuthStateCookie,
  setAuthCookie,
  getReturnToCookie,
  clearReturnToCookie,
} from "../../../lib/auth";

// GET /api/auth/callback - Handle GitHub OAuth callback
export const GET: APIRoute = async ({ request, locals }) => {
  // Rows created after this belong to an overlapping, newer sign-in.
  const startedAt = new Date().toISOString();
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Get return_to from cookie
  const returnTo = getReturnToCookie(request) || "/";

  // Helper to redirect with cookie clearing
  const redirectWithError = (reason: string) => {
    const headers = new Headers();
    // Redirect to return_to page with error param
    const returnUrl = new URL(returnTo, url.origin);
    returnUrl.searchParams.set("login", "error");
    returnUrl.searchParams.set("reason", reason);
    headers.set("Location", returnUrl.toString());
    headers.append("Set-Cookie", clearOAuthStateCookie());
    headers.append("Set-Cookie", clearReturnToCookie());
    return new Response(null, {
      status: 302,
      headers,
    });
  };

  // Validate CSRF state
  const storedState = getOAuthStateCookie(request);
  if (!state || !storedState || state !== storedState) {
    return redirectWithError("invalid_state");
  }

  if (!code) {
    return redirectWithError("missing_code");
  }

  try {
    // Exchange code for token
    const auth = createOAuthUserAuth({
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      code,
    });

    const authResult = await auth();

    // Get user info
    const octokit = new Octokit({ auth: authResult.token });
    const { data: user } = await octokit.rest.users.getAuthenticated();

    console.log(`OAuth successful for user: ${user.login}`);

    // Store token in database
    const db = drizzle(env.DB);
    const database = setupDatabase(db);

    // GitHub re-issues the scopes a user authorized before, so an old
    // `public_repo` grant keeps producing write-capable tokens. We only read,
    // so remove that grant and send the user through GitHub once more; the
    // fresh consent screen asks for (and returns) no scopes.
    const scopes =
      "scopes" in authResult && Array.isArray(authResult.scopes)
        ? (authResult.scopes as string[])
        : [];
    if (scopes.length > 0) {
      if (
        !isFreshOAuthState(state) &&
        (await revokeGrant(env, authResult.token))
      ) {
        await database.retireScopedUserTokensBefore(user.login, startedAt);
        const again = new URL("/api/auth/login", url.origin);
        again.searchParams.set("return_to", returnTo);
        again.searchParams.set("fresh", "1");
        const headers = new Headers({ Location: again.toString() });
        headers.append("Set-Cookie", clearOAuthStateCookie());
        headers.append("Set-Cookie", clearReturnToCookie());
        return new Response(null, { status: 302, headers });
      }
      // Either the grant could not be replaced, or the fresh pass still came
      // back scoped (e.g. someone hit /login?fresh=1 by hand). A scoped token
      // must never enter the pool, so drop this one and refuse the sign-in.
      // If the revoke works, the user's stored tokens died with the grant.
      if (await revokeGrant(env, authResult.token).catch(() => false)) {
        await database.retireScopedUserTokensBefore(user.login, startedAt);
      }
      console.warn(`Refused scoped token for ${user.login}`);
      return redirectWithError("scoped_token");
    }

    const expiresAt =
      "expiresAt" in authResult ? (authResult.expiresAt as string) : null;

    await database.storeToken(user.login, authResult.token, expiresAt, {
      userName: user.name ?? undefined,
      userEmail: user.email ?? undefined,
      refreshToken:
        "refreshToken" in authResult
          ? (authResult.refreshToken as string)
          : undefined,
      refreshTokenExpiresAt:
        "refreshTokenExpiresAt" in authResult
          ? (authResult.refreshTokenExpiresAt as string)
          : undefined,
      scopes: "scopes" in authResult ? scopes : undefined,
    });

    console.log(`Token stored for user: ${user.login}`);

    // Set auth cookie, clear state/return_to cookies, and redirect to return_to
    const authCookie = await setAuthCookie(user.login, env.API_SECRET);
    const headers = new Headers();
    const returnUrl = new URL(returnTo, url.origin);
    returnUrl.searchParams.set("login", "success");
    headers.set("Location", returnUrl.toString());
    headers.append("Set-Cookie", authCookie);
    headers.append("Set-Cookie", clearOAuthStateCookie());
    headers.append("Set-Cookie", clearReturnToCookie());

    return new Response(null, {
      status: 302,
      headers,
    });
  } catch (error) {
    console.error("OAuth callback error:", error);
    return redirectWithError("auth_failed");
  }
};
