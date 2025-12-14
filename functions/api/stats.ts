// GET /api/stats - Token statistics
import type { Env, PagesContext } from "../_shared";
import { jsonResponse, requireApiAuth, getDb } from "../_shared";
import { setupDatabase } from "../../src/database";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;

  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const database = setupDatabase(db);
  const stats = await database.getTokenStats();

  return jsonResponse(stats);
};
