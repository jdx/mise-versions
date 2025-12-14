// GET /auth/callback - Handle GitHub OAuth callback
import type { Env, PagesContext } from "../_shared";
import {
  redirectResponse,
  setAuthCookie,
  getDb,
  getOAuthStateCookie,
  clearOAuthStateCookie,
} from "../_shared";
import { createOAuthUserAuth } from "@octokit/auth-oauth-user";
import { Octokit } from "@octokit/rest";
import { setupDatabase } from "../../src/database";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // Validate CSRF state
  const storedState = getOAuthStateCookie(request);
  if (!state || !storedState || state !== storedState) {
    return redirectResponse("/?login=error&reason=invalid_state", {
      "Set-Cookie": clearOAuthStateCookie(),
    });
  }

  if (!code) {
    return redirectResponse("/?login=error&reason=missing_code", {
      "Set-Cookie": clearOAuthStateCookie(),
    });
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
    const db = getDb(env);
    const database = setupDatabase(db);

    const expiresAt = "expiresAt" in authResult ? (authResult.expiresAt as string) : null;

    await database.storeToken(user.login, authResult.token, expiresAt, {
      userName: user.name,
      userEmail: user.email,
      refreshToken: "refreshToken" in authResult ? (authResult.refreshToken as string) : undefined,
      refreshTokenExpiresAt:
        "refreshTokenExpiresAt" in authResult
          ? (authResult.refreshTokenExpiresAt as string)
          : undefined,
      scopes: "scopes" in authResult ? (authResult.scopes as string[]) : undefined,
    });

    console.log(`Token stored for user: ${user.login}`);

    // Set auth cookie, clear state cookie, and redirect to home
    return redirectResponse("/?login=success", [
      ["Set-Cookie", setAuthCookie(user.login)],
      ["Set-Cookie", clearOAuthStateCookie()],
    ]);
  } catch (error) {
    console.error("OAuth callback error:", error);
    return redirectResponse("/?login=error&reason=auth_failed", {
      "Set-Cookie": clearOAuthStateCookie(),
    });
  }
};
