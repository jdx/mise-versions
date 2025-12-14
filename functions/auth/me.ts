// GET /auth/me - Check current login state
import type { Env, PagesContext } from "../_shared";
import { jsonResponse, getAuthCookie } from "../_shared";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;
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
};
