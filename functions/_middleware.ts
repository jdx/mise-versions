// Middleware for Cloudflare Pages Functions
// Runs migrations on first request and handles CORS preflight
import type { Env, PagesContext } from "./_shared";
import { CORS_HEADERS, getDb } from "./_shared";
import { runMigrations } from "../src/migrations";

let migrationsCompleted = false;

export const onRequest: PagesFunction<Env> = async (context: PagesContext) => {
  const { env, request, next } = context;

  // Handle OPTIONS preflight for all routes
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  // Run migrations once on first request
  if (!migrationsCompleted) {
    try {
      console.log("🚀 Running database migrations...");
      const db = getDb(env);
      await runMigrations(db);
      migrationsCompleted = true;
      console.log("✅ Migrations completed");
    } catch (error) {
      console.error("Migration error:", error);
    }
  }

  // Continue to the actual handler
  return next();
};
