import type { APIRoute } from 'astro';
import { getFromR2 } from '../../lib/r2-data';

// GET /tools/:tool - serves plain text version list or binary files
// e.g., /tools/node returns one version per line
// e.g., /tools/python-precompiled-x86_64-unknown-linux-gnu.gz returns gzip file
export const GET: APIRoute = async ({ params, locals }) => {
  const tool = params.tool;

  if (!tool) {
    return new Response('Tool name required', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
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

    // Fetch from R2 (stored under tools/ prefix)
    const data = await getFromR2(bucket, `tools/${tool}`);

    if (!data) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Determine content type and cache duration based on file type
    let contentType = 'text/plain; charset=utf-8';
    let cacheMaxAge = 600; // 10 minutes default

    if (tool.startsWith('python-precompiled-') && tool.endsWith('.gz')) {
      // python-precompiled files rarely change, cache for 1 hour
      contentType = 'application/gzip';
      cacheMaxAge = 3600;
    } else if (tool.endsWith('.gz')) {
      contentType = 'application/gzip';
    } else if (tool.endsWith('.toml')) {
      contentType = 'text/plain; charset=utf-8';
    }

    return new Response(data.body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${cacheMaxAge}`,
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
