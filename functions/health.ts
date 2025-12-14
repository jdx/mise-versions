// GET /health - Health check with token statistics
import type { Env, PagesContext } from "./_shared";
import { jsonResponse, getDb, CORS_HEADERS } from "./_shared";
import { setupDatabase } from "../src/database";
import { getMigrationStatus } from "../src/migrations";

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { env } = context;
  const db = getDb(env);
  const database = setupDatabase(db);

  const stats = await database.getTokenStats();
  const expiringTokens = await database.getExpiringTokens();
  const migrationStatus = await getMigrationStatus(db);

  return jsonResponse({
    status: "healthy",
    timestamp: new Date().toISOString(),
    tokens: stats,
    tokenTypes: {
      total: stats.total,
      active: stats.active,
    },
    expiringTokens: expiringTokens.length,
    migrations: migrationStatus,
  });
};
