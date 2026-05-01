import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../src/analytics";
import { hashIP, getClientIP } from "../../lib/hash";
import {
  emitTelemetry,
  getMiseVersionFromHeaders,
} from "../../../../src/pipelines";
import { keyPart } from "../../lib/kv-cache";

const DOWNLOAD_DEDUPE_TTL_SECONDS = 2 * 24 * 60 * 60;

function downloadDedupeKey(
  tool: string,
  version: string,
  ipHash: string,
): string {
  const day = Math.floor(Date.now() / 86400000);
  return `download-dedupe:${day}:${keyPart(tool)}:${keyPart(version)}:${ipHash}`;
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = (await request.json()) as {
      tool: string;
      version: string;
      os?: string;
      arch?: string;
      full?: string;
    };

    if (!body.tool || !body.version) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: tool, version" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const runtime = locals.runtime;
    const clientIP = getClientIP(request);
    const ipHash = await hashIP(clientIP, runtime.env.API_SECRET);

    // Check if request is from CI environment
    const isCI = request.headers.get("x-mise-ci") === "true";

    const miseVersion = getMiseVersionFromHeaders(request.headers);

    // Always emit telemetry (includes is_ci flag for analysis)
    runtime.ctx.waitUntil(
      emitTelemetry(runtime.env, {
        schema_version: 1,
        type: "download",
        ts: Date.now(),
        tool: body.tool,
        version: body.version,
        os: body.os ?? null,
        arch: body.arch ?? null,
        full: body.full ?? null,
        ip_hash: ipHash,
        mise_version: miseVersion,
        source: "api/track",
        is_ci: isCI,
      }),
    );

    // Skip database storage for CI requests (excludes from MAU calculations)
    if (isCI) {
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

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db, {
      trackingCache: runtime.env.DOWNLOAD_DEDUPE,
    });
    const dedupeKey = downloadDedupeKey(body.tool, body.version, ipHash);

    const seen = await runtime.env.DOWNLOAD_DEDUPE.get(dedupeKey);
    if (seen) {
      return new Response(
        JSON.stringify({
          success: true,
          deduplicated: true,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    await runtime.env.DOWNLOAD_DEDUPE.put(dedupeKey, "1", {
      expirationTtl: DOWNLOAD_DEDUPE_TTL_SECONDS,
    });

    const result = await analytics.trackDownload(
      body.tool,
      body.version,
      ipHash,
      body.os || null,
      body.arch || null,
      body.full || null,
    );

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
};
