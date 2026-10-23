import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import {
  getCachedText,
  loadVersionRows,
  putCachedText,
  versionsToToml,
} from "./version-files";
import { logCostProbe, type CostProbe } from "./cost-observability";

// Legacy version endpoints `/tools/<tool>.toml` and `/<tool>.toml`, used by
// mise releases before v2026.6.6. Current releases read the static
// `/data/<tool>.toml` asset instead, and every mise client is counted from
// Cloudflare Logpush, so these routes no longer track anything: they serve the
// same static file from the edge cache or the asset binding, falling back to
// D1 for tools without one.
export async function legacyTomlResponse({
  request,
  tool,
  route,
  waitUntil,
}: {
  request: Request;
  tool: string | undefined;
  route: string;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const started = Date.now();
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
    let toml = await getCachedText(request, ":toml");
    let cache: CostProbe["cache"] = "edge";
    if (toml === null) {
      cache = "asset";
      toml = await loadStaticToml(request, tool);
      if (toml === null) {
        cache = "d1";
        const versions = await loadVersionRows(drizzle(env.ANALYTICS_DB), tool);
        if (versions === null) {
          logCostProbe({
            route,
            status: 404,
            duration_ms: Date.now() - started,
            cache,
            tracking: "none",
          });
          return new Response(`Tool "${tool}" not found`, {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          });
        }
        toml = versionsToToml(versions);
      }
      waitUntil(
        putCachedText(request, ":toml", toml, "text/plain; charset=utf-8"),
      );
    }

    logCostProbe({
      route,
      status: 200,
      duration_ms: Date.now() - started,
      cache,
      tracking: "none",
    });

    return new Response(toml, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (error) {
    console.error("Error serving legacy version file:", error);
    return new Response("Failed to fetch tool data", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function loadStaticToml(
  request: Request,
  tool: string,
): Promise<string | null> {
  const url = new URL(`/data/${tool}.toml`, request.url);
  const response = await env.ASSETS.fetch(url.toString());
  return response.ok ? response.text() : null;
}
