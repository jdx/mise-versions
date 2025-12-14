// Miscellaneous routes: health check, webhooks
import { Env, jsonResponse, getDb, CORS_HEADERS } from "../shared";
import { setupDatabase } from "../../src/database";
import { getMigrationStatus } from "../../src/migrations";

// GET /health - Health check with token statistics
export async function handleHealth(
  _request: Request,
  env: Env
): Promise<Response> {
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

// POST /webhooks/github - GitHub webhooks handler
export async function handleGitHubWebhook(request: Request): Promise<Response> {
  const eventType = request.headers.get("x-github-event");

  console.log(`Webhook received: ${eventType} event`);

  return new Response("Webhook processed", {
    status: 200,
    headers: CORS_HEADERS,
  });
}
