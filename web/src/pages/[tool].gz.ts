import type { APIRoute } from "astro";
import { getFromR2 } from "../lib/r2-data";

// Legacy endpoint: GET /:tool.gz - serves gzip compressed files from R2
// e.g., /python-precompiled-x86_64-unknown-linux-gnu.gz
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool;

  if (!tool) {
    return new Response("Tool name required", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const fullName = `${tool}.gz`;

  // Validate tool name (alphanumeric, hyphens, underscores)
  if (!/^[\w\-]+$/.test(tool)) {
    return new Response("Invalid tool name", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  try {
    const runtime = locals.runtime;
    const bucket = runtime.env.DATA_BUCKET;

    // Fetch gzip file from R2 (stored under tools/ prefix)
    const data = await getFromR2(bucket, `tools/${fullName}`);

    if (!data) {
      return new Response(`File "${fullName}" not found`, {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Cache python-precompiled files longer (1 hour vs 10 minutes)
    const cacheMaxAge = tool.startsWith("python-precompiled-") ? 3600 : 600;

    return new Response(data.body, {
      status: 200,
      headers: {
        "Content-Type": "application/gzip",
        "Cache-Control": `public, max-age=${cacheMaxAge}`,
      },
    });
  } catch (error) {
    console.error("Error fetching gzip file from R2:", error);
    return new Response("Failed to fetch file", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
};
