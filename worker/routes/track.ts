// Track routes: /api/track/* - Public endpoints for download tracking
import { drizzle } from "drizzle-orm/d1";
import { Env, jsonResponse, errorResponse, CORS_HEADERS } from "../shared";
import { setupAnalytics } from "../../src/analytics";

// Hash IP address with SHA256 for privacy, truncated to 12 chars for storage efficiency
async function hashIP(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
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

    // Hash the IP for privacy
    const ipHash = await hashIP(clientIP);

    // Get OS/arch from body (optional)
    const os = body.os || null;
    const arch = body.arch || null;

    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.trackDownload(
      body.tool,
      body.version,
      ipHash,
      os,
      arch
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

    return jsonResponse(stats);
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

    return jsonResponse(stats);
  } catch (error) {
    console.error("Get all downloads error:", error);
    return errorResponse("Failed to get download stats", 500);
  }
}
