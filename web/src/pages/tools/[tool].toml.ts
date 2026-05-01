import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { hashIP, getClientIP } from "../../lib/hash";
import { setupAnalytics } from "../../../../src/analytics";
import {
  emitTelemetry,
  getMiseVersionFromHeaders,
} from "../../../../src/pipelines";
import {
  getCachedVersionRows,
  getCachedText,
  loadVersionRows,
  putCachedVersionRows,
  putCachedText,
  versionsToToml,
} from "../../lib/version-files";

export const GET: APIRoute = async ({ request, params, locals }) => {
  const { tool } = params;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes for namespaced tools)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);

    let toml = await getCachedText(request, ":toml");
    if (toml === null) {
      let versions = await getCachedVersionRows(
        runtime.env.DOWNLOAD_DEDUPE,
        tool,
      );
      if (versions === null) {
        versions = await loadVersionRows(db, tool);
        if (versions !== null) {
          runtime.ctx.waitUntil(
            putCachedVersionRows(
              runtime.env.DOWNLOAD_DEDUPE,
              tool,
              {},
              versions,
            ),
          );
        }
      }
      if (versions === null) {
        return new Response(`Tool "${tool}" not found`, {
          status: 404,
          headers: { "Content-Type": "text/plain" },
        });
      }
      toml = versionsToToml(versions);
      runtime.ctx.waitUntil(
        putCachedText(request, ":toml", toml, "text/plain; charset=utf-8"),
      );
    }

    // Track version request for DAU/MAU using waitUntil to ensure it completes
    const clientIP = getClientIP(request);
    const miseVersion = getMiseVersionFromHeaders(request.headers);
    const isCI = request.headers.get("x-mise-ci") === "true";
    runtime.ctx.waitUntil(
      hashIP(clientIP, runtime.env.API_SECRET).then(async (ipHash) => {
        try {
          // Always emit telemetry (includes is_ci flag for analysis)
          await emitTelemetry(runtime.env, {
            schema_version: 1,
            type: "version_request",
            ts: Date.now(),
            tool,
            ip_hash: ipHash,
            mise_version: miseVersion,
            source: "toml",
            is_ci: isCI,
          });
          // Skip database storage for CI requests (excludes from MAU calculations)
          if (!isCI) {
            const analytics = setupAnalytics(db, {
              trackingCache: runtime.env.DOWNLOAD_DEDUPE,
            });
            await analytics.trackVersionRequest(ipHash);
          }
        } catch (e) {
          console.error("Failed to track version request:", e);
        }
      }),
    );

    return new Response(toml, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (error) {
    console.error("Error fetching versions from D1:", error);
    return new Response("Failed to fetch tool data", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};
