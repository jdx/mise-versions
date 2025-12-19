import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { getFromR2 } from '../../lib/r2-data';

// GET /tools/:tool - serves plain text version list from D1, or binary files from R2
// e.g., /tools/node returns one version per line (from D1)
// e.g., /tools/python-precompiled-x86_64-unknown-linux-gnu.gz returns gzip file (from R2)
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

  const runtime = locals.runtime;

  // Binary files (.gz) are served from R2
  if (tool.endsWith('.gz')) {
    try {
      const bucket = runtime.env.DATA_BUCKET;
      const data = await getFromR2(bucket, `tools/${tool}`);

      if (!data) {
        return new Response(`File "${tool}" not found`, {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      // Cache python-precompiled files longer (1 hour vs 10 minutes)
      const cacheMaxAge = tool.startsWith('python-precompiled-') ? 3600 : 600;

      return new Response(data.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/gzip',
          'Cache-Control': `public, max-age=${cacheMaxAge}`,
        },
      });
    } catch (error) {
      console.error('Error fetching binary from R2:', error);
      return new Response('Failed to fetch file', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }

  // Regular tools are served from D1
  try {
    const db = drizzle(runtime.env.ANALYTICS_DB);

    // Get tool_id
    const toolResult = await db.all(sql`
      SELECT id FROM tools WHERE name = ${tool}
    `);

    if (toolResult.length === 0) {
      return new Response(`Tool "${tool}" not found`, {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const toolId = (toolResult[0] as { id: number }).id;

    // Get versions ordered by id (insertion order = oldest first)
    const versions = await db.all<{ version: string }>(sql`
      SELECT version
      FROM versions
      WHERE tool_id = ${toolId}
      ORDER BY id ASC
    `);

    const text = versions.map(v => v.version).join('\n') + '\n';

    return new Response(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      },
    });
  } catch (error) {
    console.error('Error fetching versions from D1:', error);
    return new Response('Failed to fetch tool data', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
