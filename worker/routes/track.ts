// Track routes: /api/track/* - Public endpoints for download tracking
import { drizzle } from "drizzle-orm/d1";
import { Env, jsonResponse, errorResponse, cachedJsonResponse, CACHE_CONTROL, CORS_HEADERS } from "../shared";
import { setupAnalytics } from "../../src/analytics";

// Hash IP address with HMAC-SHA256 for privacy, truncated to 12 chars for storage efficiency
// Using HMAC with a secret key prevents rainbow table attacks on the limited IPv4 address space
async function hashIP(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

// POST /api/track - Track a tool installation (public, no auth)
export async function handleTrack(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const body = (await request.json()) as {
      tool: string;
      version: string;
      os?: string;
      arch?: string;
      full?: string; // Full backend identifier (e.g., "aqua:nektos/act")
    };

    // Validate required fields
    if (!body.tool || !body.version) {
      return errorResponse("Missing required fields: tool, version", 400);
    }

    // Get client IP (Cloudflare provides this header)
    const clientIP =
      request.headers.get("CF-Connecting-IP") ||
      request.headers.get("X-Forwarded-For")?.split(",")[0] ||
      "unknown";

    // Hash the IP for privacy (HMAC with secret prevents rainbow table attacks)
    const ipHash = await hashIP(clientIP, env.API_SECRET);

    // Get OS/arch from body (optional)
    const os = body.os || null;
    const arch = body.arch || null;
    const full = body.full || null;

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.trackDownload(
      body.tool,
      body.version,
      ipHash,
      os,
      arch,
      full
    );

    return jsonResponse({
      success: true,
      deduplicated: result.deduplicated,
    });
  } catch (error) {
    console.error("Track error:", error);
    return errorResponse("Failed to track download", 500);
  }
}

// GET /api/downloads/:tool - Get download stats for a specific tool (public)
export async function handleGetToolDownloads(
  request: Request,
  env: Env,
  tool: string
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getDownloadStats(tool);

    return cachedJsonResponse(stats, CACHE_CONTROL.API);
  } catch (error) {
    console.error("Get tool downloads error:", error);
    return errorResponse("Failed to get download stats", 500);
  }
}

// GET /api/downloads - Get aggregate download stats (public)
export async function handleGetAllDownloads(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getTopTools(20);

    return cachedJsonResponse(stats, CACHE_CONTROL.API);
  } catch (error) {
    console.error("Get all downloads error:", error);
    return errorResponse("Failed to get download stats", 500);
  }
}

// GET /api/downloads/30d - Get 30-day download counts for all tools (public)
export async function handleGet30DayDownloads(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const counts = await analytics.getAll30DayDownloads();

    return cachedJsonResponse(counts, CACHE_CONTROL.API);
  } catch (error) {
    console.error("Get 30-day downloads error:", error);
    return errorResponse("Failed to get download stats", 500);
  }
}

// GET /api/stats/mau - Get monthly active users (public)
export async function handleGetMAU(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const mau = await analytics.getMAU();

    return cachedJsonResponse({ mau }, CACHE_CONTROL.API);
  } catch (error) {
    console.error("Get MAU error:", error);
    return errorResponse("Failed to get MAU", 500);
  }
}

// POST /api/admin/aggregate - Aggregate old download data (requires auth)
export async function handleAggregate(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Verify admin secret
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse("Unauthorized", 401);
    }

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.aggregateOldData();

    return jsonResponse({
      success: true,
      aggregated: result.aggregated,
      deleted: result.deleted,
    });
  } catch (error) {
    console.error("Aggregate error:", error);
    return errorResponse("Failed to aggregate data", 500);
  }
}

// GET /api/stats/backends - Get download stats by backend (public)
export async function handleGetBackendStats(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getBackendStats();

    return cachedJsonResponse(stats, CACHE_CONTROL.API);
  } catch (error) {
    console.error("Get backend stats error:", error);
    return errorResponse("Failed to get backend stats", 500);
  }
}

// POST /api/admin/backfill-backends - Backfill backend_id using registry data (requires auth)
export async function handleBackfillBackends(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Verify admin secret
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse("Unauthorized", 401);
    }

    const body = (await request.json()) as {
      registry: Array<{ short: string; backends: string[] }>;
    };

    if (!body.registry || !Array.isArray(body.registry)) {
      return errorResponse("Missing or invalid registry data", 400);
    }

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.backfillBackends(body.registry);

    return jsonResponse({
      success: true,
      updated: result.updated,
      tools_mapped: result.tools_mapped,
    });
  } catch (error) {
    console.error("Backfill error:", error);
    return errorResponse(`Failed to backfill backends: ${error}`, 500);
  }
}

// POST /api/admin/finalize-backends - Make backend_id NOT NULL (requires auth)
export async function handleFinalizeBackends(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    // Verify admin secret
    const authHeader = request.headers.get("Authorization");
    const expectedAuth = `Bearer ${env.API_SECRET}`;
    if (authHeader !== expectedAuth) {
      return errorResponse("Unauthorized", 401);
    }

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    await analytics.makeBackendIdNotNull();

    return jsonResponse({
      success: true,
      message: "backend_id is now NOT NULL",
    });
  } catch (error) {
    console.error("Finalize backends error:", error);
    return errorResponse(`Failed to finalize backends: ${error}`, 500);
  }
}
