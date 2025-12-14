// POST /api/token/rate-limit - Mark a token as rate-limited
import type { Env, PagesContext } from "../../_shared";
import { jsonResponse, errorResponse, requireApiAuth, getDb, CORS_HEADERS } from "../../_shared";
import { setupDatabase } from "../../../src/database";

export const onRequestPost: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;

  // Require API auth
  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const database = setupDatabase(db);

  const rateLimitData = (await request.json()) as {
    token_id: number;
    reset_at: string;
  };

  await database.markTokenRateLimited(rateLimitData.token_id, rateLimitData.reset_at);

  return new Response("Token marked as rate-limited", { headers: CORS_HEADERS });
};

// Handle OPTIONS preflight
export const onRequestOptions: PagesFunction<Env> = async () => {
  return new Response(null, { headers: CORS_HEADERS });
};
