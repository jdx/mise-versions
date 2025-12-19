import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { hashIP, getClientIP } from '../lib/hash';
import { setupAnalytics } from '../../../src/analytics';
import { emitTelemetry, getMiseVersionFromHeaders } from '../../../src/pipelines';

interface VersionRow {
  version: string;
  created_at: string | null;
  release_url: string | null;
}

// Legacy endpoint: GET /:tool.toml - serves TOML version file from D1
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
    const versions = await db.all<VersionRow>(sql`
      SELECT version, created_at, release_url
      FROM versions
      WHERE tool_id = ${toolId}
      ORDER BY id ASC
    `);

    // Track version request for DAU/MAU using waitUntil to ensure it completes
    const clientIP = getClientIP(request);
    const miseVersion = getMiseVersionFromHeaders(request.headers);
    runtime.ctx.waitUntil(
      hashIP(clientIP, runtime.env.API_SECRET).then(async (ipHash) => {
        try {
          const analytics = setupAnalytics(db);
          await analytics.trackVersionRequest(ipHash);
          await emitTelemetry(runtime.env, {
            schema_version: 1,
            type: "version_request",
            ts: Date.now(),
            tool,
            ip_hash: ipHash,
            mise_version: miseVersion,
            source: "toml",
          });
        } catch (e) {
          console.error('Failed to track version request:', e);
        }
      })
    );

    // Generate TOML output
    const lines = ['[versions]'];
    for (const v of versions) {
      const parts: string[] = [];
      if (v.created_at) {
        parts.push(`created_at = ${v.created_at}`);
      }
      if (v.release_url) {
        parts.push(`release_url = "${v.release_url}"`);
      }

      if (parts.length > 0) {
        lines.push(`"${v.version}" = { ${parts.join(', ')} }`);
      } else {
        lines.push(`"${v.version}" = {}`);
      }
    }

    return new Response(lines.join('\n') + '\n', {
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
