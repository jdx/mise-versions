import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import {
  getCachedText,
  loadVersionRows,
  putCachedText,
  versionsToText,
} from "../../lib/version-files";

// GET /tools/:tool - serves plain text version list from D1
// e.g., /tools/node returns one version per line
// Note: .gz files are handled by [tool].gz.ts
export const GET: APIRoute = async ({ request, params, locals }) => {
  const tool = params.tool;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const runtime = locals.runtime;

  try {
    const cached = await getCachedText(request, ":text");
    if (cached !== null) {
      return new Response(cached, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=600",
        },
      });
    }

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const versions = await loadVersionRows(db, tool, { stableOnly: true });
    if (versions === null) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const text = versionsToText(versions);
    runtime.ctx.waitUntil(
      putCachedText(request, ":text", text, "text/plain; charset=utf-8"),
    );

    return new Response(text, {
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
