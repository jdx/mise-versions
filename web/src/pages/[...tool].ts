import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

// Legacy endpoint: GET /:tool - serves plain text version list from D1
// e.g., /node returns one version per line
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Skip known routes that aren't tools
  const reservedPaths = [
    "stats",
    "tools",
    "data",
    "api",
    "badge",
    "health",
    "webhooks",
    "admin",
  ];
  const firstSegment = tool.split("/")[0];
  if (reservedPaths.includes(firstSegment)) {
    return new Response("Not found", { status: 404 });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const runtime = locals.runtime;
    const db = drizzle(runtime.env.ANALYTICS_DB);

    // Get tool_id
    const toolResult = await db.all(sql`
      SELECT id FROM tools WHERE name = ${tool}
    `);

    if (toolResult.length === 0) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const toolId = (toolResult[0] as { id: number }).id;

    // Get versions ordered by sort_order (semantic version order from TOML file)
    // Only include versions from mise ls-remote (not user-tracked installs)
    const versions = await db.all<{ version: string }>(sql`
      SELECT version FROM versions WHERE tool_id = ${toolId} AND from_mise = 1 ORDER BY sort_order ASC, id ASC
    `);

    if (versions.length === 0) {
      return new Response("", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=600",
        },
      });
    }

    const text = versions.map((v) => v.version).join("\n") + "\n";

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
