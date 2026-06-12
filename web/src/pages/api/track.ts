import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../src/analytics";
import { hashIP, getClientIP } from "../../lib/hash";
import { env } from "cloudflare:workers";
import { logCostProbe } from "../../lib/cost-observability";
import { analyticsEventsBinding } from "../../lib/analytics-events";

export const POST: APIRoute = async ({ request }) => {
  return trackDownloadRequest({ request });
};

export async function trackDownloadRequest({
  request,
  tool: pathTool,
}: {
  request: Parameters<APIRoute>[0]["request"];
  tool?: string;
}) {
  const started = Date.now();
  try {
    const body = (await request.json()) as {
      tool?: string;
      version: string;
      os?: string;
      arch?: string;
      full?: string;
    };

    const tool = pathTool || body.tool;

    if (!tool || !body.version) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: tool, version" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const clientIP = getClientIP(request);
    const ipHash = await hashIP(clientIP, env.API_SECRET);

    // Check if request is from CI environment
    const isCI = request.headers.get("x-mise-ci") === "true";

    // Skip database storage for CI requests (excludes from MAU calculations)
    if (isCI) {
      logCostProbe({
        route: "api/track",
        status: 200,
        duration_ms: Date.now() - started,
        cache: "none",
        tracking: "ci_skipped",
        d1_write: "skipped",
      });
      return new Response(
        JSON.stringify({
          success: true,
          deduplicated: false,
          ci: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const db = drizzle(env.ANALYTICS_DB);
    const analyticsEvents = analyticsEventsBinding();
    const analytics = setupAnalytics(db, {
      trackingCache: env.DOWNLOAD_DEDUPE,
      analyticsEvents,
    });

    const result = await analytics.trackDownload(
      tool,
      body.version,
      ipHash,
      body.os || null,
      body.arch || null,
      body.full || null,
    );

    logCostProbe({
      route: "api/track",
      status: 200,
      duration_ms: Date.now() - started,
      cache: "none",
      tracking: result.deduplicated ? "none" : "queued",
      d1_write: analyticsEvents ? "skipped" : "attempted",
    });

    return new Response(
      JSON.stringify({
        success: true,
        deduplicated: result.deduplicated,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Track error:", error);
    return new Response(JSON.stringify({ error: "Failed to track download" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
