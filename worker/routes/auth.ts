// Auth routes: /auth/*
import {
  Env,
  jsonResponse,
  redirectResponse,
  getAuthCookie,
  setAuthCookie,
  clearAuthCookie,
  setOAuthStateCookie,
  getOAuthStateCookie,
  clearOAuthStateCookie,
  getDb,
} from "../shared";
import { createOAuthUserAuth } from "@octokit/auth-oauth-user";
import { Octokit } from "@octokit/rest";
import { setupDatabase } from "../../src/database";

// GET /auth/login - Redirect to GitHub OAuth
export async function handleLogin(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);

  const redirectUri = `${url.origin}/auth/callback`;
  const scope = "public_repo";
  const state = crypto.randomUUID();

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthUrl.searchParams.set("scope", scope);
  githubAuthUrl.searchParams.set("state", state);

  // Store state in cookie for CSRF validation in callback
  return redirectResponse(githubAuthUrl.toString(), {
    "Set-Cookie": setOAuthStateCookie(state),
  });
}

// GET /auth/callback - Handle GitHub OAuth callback
export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
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

    const expiresAt =
      "expiresAt" in authResult ? (authResult.expiresAt as string) : null;

    await database.storeToken(user.login, authResult.token, expiresAt, {
      userName: user.name,
      userEmail: user.email,
      refreshToken:
        "refreshToken" in authResult
          ? (authResult.refreshToken as string)
          : undefined,
      refreshTokenExpiresAt:
        "refreshTokenExpiresAt" in authResult
          ? (authResult.refreshTokenExpiresAt as string)
          : undefined,
      scopes:
        "scopes" in authResult ? (authResult.scopes as string[]) : undefined,
    });

    console.log(`Token stored for user: ${user.login}`);

    // Set auth cookie, clear state cookie, and redirect to home
    const authCookie = await setAuthCookie(user.login, env.API_SECRET);
    return redirectResponse("/?login=success", [
      ["Set-Cookie", authCookie],
      ["Set-Cookie", clearOAuthStateCookie()],
    ]);
  } catch (error) {
    console.error("OAuth callback error:", error);
    return redirectResponse("/?login=error&reason=auth_failed", {
      "Set-Cookie": clearOAuthStateCookie(),
    });
  }
}

// GET /auth/me - Check current login state
export async function handleMe(request: Request, env: Env): Promise<Response> {
  const auth = await getAuthCookie(request, env.API_SECRET);

  if (auth) {
    return jsonResponse({
      authenticated: true,
      username: auth.username,
    });
  }

  return jsonResponse({
    authenticated: false,
  });
}

// GET/POST /auth/logout - Clear auth cookie and log out
export async function handleLogout(): Promise<Response> {
  const cookie = clearAuthCookie();
  return redirectResponse("/", {
    "Set-Cookie": cookie,
  });
}
