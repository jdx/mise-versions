// GET /api/migrations - Database migration status
import type { Env, PagesContext } from "../_shared";
import { jsonResponse, requireApiAuth, getDb } from "../_shared";
import { getMigrationStatus } from "../../src/migrations";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request } = context;

  const authError = requireApiAuth(request, env);
  if (authError) return authError;

  const db = getDb(env);
  const migrationStatus = await getMigrationStatus(db);

  return jsonResponse(migrationStatus);
};
