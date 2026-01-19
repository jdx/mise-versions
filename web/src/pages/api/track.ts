import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../src/analytics";
import { hashIP, getClientIP } from "../../lib/hash";
import {
  emitTelemetry,
  getMiseVersionFromHeaders,
} from "../../../../src/pipelines";

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

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.trackDownload(
      body.tool,
      body.version,
      ipHash,
      body.os || null,
      body.arch || null,
      body.full || null,
    );

    const miseVersion = getMiseVersionFromHeaders(request.headers);
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
      }),
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
