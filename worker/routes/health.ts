// Health routes: /health
import { Env, jsonResponse, getDb } from "../shared";
import { setupDatabase } from "../../src/database";
import { getMigrationStatus } from "../../src/migrations";

// GET /health - Health check with token statistics
export async function handleHealth(env: Env): Promise<Response> {
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
}
