import type { APIRoute } from 'astro';
import { getFromR2 } from '../lib/r2-data';

// Legacy endpoint: GET /:tool - serves plain text version list
// e.g., /node returns one version per line
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool;

  if (!tool) {
    return new Response('Tool name required', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Skip known routes that aren't tools
  const reservedPaths = ['stats', 'tools', 'data', 'api', 'badge', 'health', 'webhooks'];
  const firstSegment = tool.split('/')[0];
  if (reservedPaths.includes(firstSegment)) {
    return new Response('Not found', { status: 404 });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes, periods for extensions)
  if (!/^[\w\-\/\.]+$/.test(tool)) {
    return new Response('Invalid tool name', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    const runtime = locals.runtime;
    const bucket = runtime.env.DATA_BUCKET;

    // Fetch plain text version file from R2
    const data = await getFromR2(bucket, `tools/${tool}`);

    if (!data) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Determine content type based on extension
    let contentType = 'text/plain; charset=utf-8';
    if (tool.endsWith('.gz')) {
      contentType = 'application/gzip';
    } else if (tool.endsWith('.toml')) {
      contentType = 'text/plain; charset=utf-8';
    }

    return new Response(data.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=600',
      },
    });
  } catch (error) {
    console.error('Error fetching tool from R2:', error);
    return new Response('Failed to fetch tool data', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
