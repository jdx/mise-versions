import type { APIRoute } from 'astro';
import { ImageResponse } from 'workers-og';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../src/analytics';
import { loadToolsJson, type ToolMeta } from '../../../lib/data-loader';

interface OGToolMeta {
  name: string;
  description?: string;
  latest_version: string;
  version_count: number;
  github?: string;
  backends?: string[];
}

// Get primary backend type from backends array
function getPrimaryBackend(backends?: string[]): string | null {
  if (!backends || backends.length === 0) return null;
  const backend = backends[0];
  const colonIndex = backend.indexOf(':');
  return colonIndex > 0 ? backend.slice(0, colonIndex) : backend;
}

// Format download count for display
function formatDownloads(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const MISE_LOGO_URL = 'https://mise.jdx.dev/logo.svg';

function generateImage(tool: OGToolMeta, downloads: number | null, backend: string | null): Response {
  const description = tool.description
    ? tool.description.length > 120
      ? tool.description.slice(0, 120) + '...'
      : tool.description
    : '';

  const versionText = tool.latest_version ? `v${tool.latest_version}` : '';

  // Build stat badges
  const backendBadge = backend
    ? `<div style="display: flex; align-items: center; background: rgba(0, 212, 255, 0.1); border: 1px solid rgba(0, 212, 255, 0.3); border-radius: 8px; padding: 12px 20px;">
        <span style="font-size: 20px; color: #00D4FF; font-weight: 600;">${escapeHtml(backend)}</span>
       </div>`
    : '';

  const downloadsBadge = downloads
    ? `<div style="display: flex; align-items: center; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 12px 20px;">
        <span style="font-size: 28px; color: #ffffff; font-weight: 700;">${formatDownloads(downloads)}</span>
        <span style="font-size: 18px; color: #9ca3af; margin-left: 10px;">downloads</span>
       </div>`
    : '';

  const versionsBadge = tool.version_count > 0
    ? `<div style="display: flex; align-items: center; background: rgba(176, 38, 255, 0.1); border: 1px solid rgba(176, 38, 255, 0.3); border-radius: 8px; padding: 12px 20px;">
        <span style="font-size: 20px; color: #B026FF; font-weight: 600;">${tool.version_count}</span>
        <span style="font-size: 18px; color: #9ca3af; margin-left: 8px;">versions</span>
       </div>`
    : '';

  const html = `
    <div style="display: flex; flex-direction: column; width: 1200px; height: 630px; background: linear-gradient(135deg, #0d0d14 0%, #1a1a2e 50%, #0d0d14 100%); padding: 50px 60px;">
      <!-- Header: branding -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <img src="${MISE_LOGO_URL}" width="36" height="36" />
          <span style="font-size: 24px; font-weight: 700; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        </div>
        <span style="font-size: 18px; color: #4b5563;">mise-tools.jdx.dev</span>
      </div>

      <!-- Main content -->
      <div style="display: flex; flex-direction: column; flex: 1; justify-content: center;">
        <!-- Tool name and version -->
        <div style="display: flex; align-items: baseline; gap: 20px; margin-bottom: 24px;">
          <span style="font-size: 72px; font-weight: 800; color: #B026FF;">${escapeHtml(tool.name)}</span>
          ${versionText ? `<span style="font-size: 32px; color: #00D4FF; font-family: monospace;">${escapeHtml(versionText)}</span>` : ''}
        </div>

        <!-- Description -->
        ${description ? `<p style="font-size: 28px; color: #d1d5db; margin: 0 0 32px 0; line-height: 1.5;">${escapeHtml(description)}</p>` : ''}

        <!-- Stats badges -->
        <div style="display: flex; gap: 16px; flex-wrap: wrap;">
          ${backendBadge}
          ${downloadsBadge}
          ${versionsBadge}
        </div>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    headers: {
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
}

// GET /api/og/:tool - Generate OG image for a tool
export const GET: APIRoute = async ({ params, locals }) => {
  const toolName = params.tool!;
  const runtime = locals.runtime;
  const bucket = runtime.env.DATA_BUCKET;

  // Fetch tool meta and downloads in parallel
  const [toolsData, downloads] = await Promise.all([
    loadToolsJson(bucket),
    (async () => {
      try {
        const db = drizzle(runtime.env.ANALYTICS_DB);
        const analytics = setupAnalytics(db);
        const stats = await analytics.getDownloadStats(toolName);
        return stats.total || null;
      } catch {
        return null;
      }
    })(),
  ]);

  const tool = toolsData?.tools.find((t) => t.name === toolName);

  if (!tool) {
    // Return a generic mise tools image for unknown tools
    return generateImage({
      name: toolName,
      description: 'Tool not found',
      latest_version: '',
      version_count: 0,
    }, null, null);
  }

  const backend = getPrimaryBackend(tool.backends);
  return generateImage(tool, downloads, backend);
};
