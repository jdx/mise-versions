import type { APIRoute } from 'astro';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../src/analytics';

// Hash IP address with HMAC-SHA256 for privacy
async function hashIP(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(ip));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json() as {
      tool: string;
      version: string;
      os?: string;
      arch?: string;
      full?: string;
    };

    if (!body.tool || !body.version) {
      return new Response(JSON.stringify({ error: 'Missing required fields: tool, version' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const runtime = locals.runtime;

    // Get client IP
    const clientIP =
      request.headers.get('CF-Connecting-IP') ||
      request.headers.get('X-Forwarded-For')?.split(',')[0] ||
      'unknown';

    const ipHash = await hashIP(clientIP, runtime.env.API_SECRET);

    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const result = await analytics.trackDownload(
      body.tool,
      body.version,
      ipHash,
      body.os || null,
      body.arch || null,
      body.full || null
    );

    return new Response(JSON.stringify({
      success: true,
      deduplicated: result.deduplicated,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Track error:', error);
    return new Response(JSON.stringify({ error: 'Failed to track download' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
