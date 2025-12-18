import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { getFromR2 } from '../lib/r2-data';
import { hashIP, getClientIP } from '../lib/hash';
import { setupAnalytics } from '../../../src/analytics';

// Legacy endpoint: GET /:tool.toml - serves TOML version file
// e.g., /node.toml returns TOML with version metadata
export const GET: APIRoute = async ({ request, params, locals }) => {
  const tool = params.tool;

  if (!tool) {
    return new Response('Tool name required', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes for namespaced tools)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response('Invalid tool name', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    const runtime = locals.runtime;
    const bucket = runtime.env.DATA_BUCKET;

    // Fetch TOML from R2
    const data = await getFromR2(bucket, `tools/${tool}.toml`);

    if (!data) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Track version request for DAU/MAU (fire and forget)
    const clientIP = getClientIP(request);
    hashIP(clientIP, runtime.env.API_SECRET).then(async (ipHash) => {
      try {
        const db = drizzle(runtime.env.ANALYTICS_DB);
        const analytics = setupAnalytics(db);
        await analytics.trackVersionRequest(ipHash);
      } catch (e) {
        console.error('Failed to track version request:', e);
      }
    });

    return new Response(data.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
    });
  } catch (error) {
    console.error('Error fetching TOML from R2:', error);
    return new Response('Failed to fetch tool data', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
