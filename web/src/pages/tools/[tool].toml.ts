import type { APIRoute } from 'astro';
import { getFromR2 } from '../../lib/r2-data';

export const GET: APIRoute = async ({ params, locals }) => {
  const { tool } = params;

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

    // Fetch TOML from R2 (stored under tools/ prefix)
    const data = await getFromR2(bucket, `tools/${tool}.toml`);

    if (!data) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new Response(data.body, {
      status: 200,
      headers: {
        'Content-Type': data.contentType,
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
