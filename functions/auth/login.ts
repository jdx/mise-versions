// GET /auth/login - Redirect to GitHub OAuth
import type { Env, PagesContext } from "../_shared";
import { redirectResponse } from "../_shared";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;
  const url = new URL(request.url);

  const redirectUri = `${url.origin}/auth/callback`;
  const scope = "public_repo";
  const state = crypto.randomUUID();

  const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
  githubAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  githubAuthUrl.searchParams.set("redirect_uri", redirectUri);
  githubAuthUrl.searchParams.set("scope", scope);
  githubAuthUrl.searchParams.set("state", state);

  return redirectResponse(githubAuthUrl.toString());
};
