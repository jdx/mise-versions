import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";
import { setupDatabase } from "../../../src/database";
import { getMigrationStatus } from "../../../src/migrations";
import { jsonResponse } from "../lib/api";

interface HealthCheck {
  name: string;
  status: "healthy" | "unhealthy";
  latencyMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

async function checkDatabase(
  name: string,
  dbBinding: D1Database | undefined,
): Promise<HealthCheck> {
  if (!dbBinding) {
    return {
      name,
      status: "unhealthy",
      error: "Database binding not configured",
    };
  }

  const start = Date.now();
  try {
    const db = drizzle(dbBinding);
    // Simple connectivity check - use .all() for SELECT queries
    await db.all(sql`SELECT 1`);
    return {
      name,
      status: "healthy",
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      name,
      status: "unhealthy",
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

// GET /health - Health check with D1 connectivity verification
export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;
  const checks: HealthCheck[] = [];

  // Check token database (DB)
  const tokenDbCheck = await checkDatabase("token_db", runtime.env.DB);
  checks.push(tokenDbCheck);

  // Check analytics database (ANALYTICS_DB)
  const analyticsDbCheck = await checkDatabase(
    "analytics_db",
    runtime.env.ANALYTICS_DB,
  );
  checks.push(analyticsDbCheck);

  // Get additional details if token DB is healthy
  let tokenStats = null;
  let expiringTokens: number | null = null;
  let migrationStatus = null;

  if (tokenDbCheck.status === "healthy") {
    try {
      const db = drizzle(runtime.env.DB);
      const database = setupDatabase(db);
      tokenStats = await database.getTokenStats();
      const expiring = await database.getExpiringTokens();
      expiringTokens = expiring.length;
      migrationStatus = await getMigrationStatus(db);
    } catch (error) {
      // Non-critical - health check still passes if basic connectivity works
      console.error(
        "Failed to retrieve token statistics for health check:",
        error,
      );
    }
  }

  const allHealthy = checks.every((c) => c.status === "healthy");

  return jsonResponse(
    {
      status: allHealthy ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      checks,
      tokens: tokenStats,
      expiringTokens,
      migrations: migrationStatus,
    },
    allHealthy ? 200 : 503,
  );
};
