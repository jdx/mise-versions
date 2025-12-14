// POST /auth/logout - Clear auth cookie and log out
import type { Env, PagesContext } from "../_shared";
import { redirectResponse, clearAuthCookie } from "../_shared";

export const onRequestPost: PagesFunction<Env> = async () => {
  const cookie = clearAuthCookie();
  return redirectResponse("/", {
    "Set-Cookie": cookie,
  });
};

// Also support GET for easy logout links
export const onRequestGet: PagesFunction<Env> = async () => {
  const cookie = clearAuthCookie();
  return redirectResponse("/", {
    "Set-Cookie": cookie,
  });
};
