import type { APIRoute } from 'astro';
import { ImageResponse } from 'workers-og';
import { drizzle } from 'drizzle-orm/d1';
import { setupAnalytics } from '../../../../../src/analytics';
import { loadToolsJson } from '../../../lib/data-loader';

interface TrendingTool {
  name: string;
  downloads_30d: number;
  trendingScore: number;
  dailyBoost: number;
  sparkline: number[];
  description?: string;
  backends?: string[];
  version_count?: number;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cleanBackend(backend: string): string {
  const bracketIndex = backend.indexOf('[');
  let result = bracketIndex > 0 ? backend.slice(0, bracketIndex) : backend;
  if (result.length > 25) result = result.slice(0, 25) + '...';
  return result;
}

function formatDownloads(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

// Generate sparkline SVG path
function generateSparklinePath(data: number[], width: number, height: number): string {
  if (!data || data.length === 0) return '';
  const max = Math.max(...data, 1);
  const padding = 2;

  return data.map((value, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - (value / max) * (height - padding * 2);
    return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
  }).join(' ');
}

function generateToolCard(tool: TrendingTool, index: number): string {
  const description = tool.description
    ? tool.description.length > 60
      ? tool.description.slice(0, 60) + '...'
      : tool.description
    : '';

  const backend = tool.backends && tool.backends[0] ? cleanBackend(tool.backends[0]) : '';
  const sparklinePath = generateSparklinePath(tool.sparkline || [], 60, 20);

  // Indicator for trending
  const indicator = tool.dailyBoost > 40
    ? '<span style="color: #fb923c; margin-left: 4px;">🔥</span>'
    : tool.dailyBoost > 20
      ? '<span style="color: #4ade80; margin-left: 4px; font-weight: bold;">↑</span>'
      : '';

  return `
    <div style="display: flex; flex-direction: column; background: #1a1a2e; border: 1px solid #2d2d44; border-radius: 12px; padding: 16px; width: 340px;">
      <!-- Header row -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <div style="display: flex; align-items: center;">
          <span style="font-size: 11px; color: #6b7280; font-family: monospace; background: #0d0d14; padding: 2px 6px; border-radius: 4px; margin-right: 8px;">#${index + 1}</span>
          <span style="font-size: 16px; font-weight: 600; color: #f3f4f6;">${escapeHtml(tool.name)}</span>
          ${indicator}
        </div>
        <span style="font-size: 14px; font-weight: 600; color: #00D4FF;">${formatDownloads(tool.downloads_30d)}</span>
      </div>
      <!-- Description -->
      <div style="font-size: 12px; color: #9ca3af; margin-bottom: 10px; line-height: 1.4; min-height: 34px;">
        ${escapeHtml(description)}
      </div>
      <!-- Footer -->
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <div style="display: flex; align-items: center; gap: 8px;">
          ${backend ? `<span style="font-size: 11px; color: #6b7280; background: #0d0d14; padding: 2px 8px; border-radius: 4px;">${escapeHtml(backend)}</span>` : ''}
          ${tool.version_count ? `<span style="font-size: 11px; color: #6b7280;">${tool.version_count} versions</span>` : ''}
        </div>
        ${sparklinePath ? `
          <svg width="60" height="20" style="opacity: 0.7;">
            <path d="${sparklinePath}" fill="none" stroke="#B026FF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        ` : ''}
      </div>
    </div>
  `;
}

// GET /api/og - Generate OG image for homepage with Hot Tools
export const GET: APIRoute = async ({ locals }) => {
  const runtime = locals.runtime;

  let trendingTools: TrendingTool[] = [];
  let toolCount = 960;

  try {
    const bucket = runtime.env.DATA_BUCKET;
    const db = drizzle(runtime.env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    // Fetch trending tools and tool metadata in parallel
    const [trending, toolsData] = await Promise.all([
      analytics.getTrendingTools(6),
      loadToolsJson(bucket),
    ]);

    if (toolsData) {
      toolCount = toolsData.tool_count;
      const toolMap = new Map(toolsData.tools.map(t => [t.name, t]));
      trendingTools = trending.map(t => {
        const meta = toolMap.get(t.name);
        return {
          ...t,
          description: meta?.description,
          backends: meta?.backends,
          version_count: meta?.version_count,
        };
      });
    }
  } catch (e) {
    console.error('Failed to fetch trending tools for OG image:', e);
  }

  // Generate tool cards HTML
  const toolCardsHtml = trendingTools.length > 0
    ? trendingTools.map((tool, i) => generateToolCard(tool, i)).join('')
    : '';

  const html = `
    <div style="display: flex; flex-direction: column; width: 1200px; height: 630px; background: linear-gradient(135deg, #0d0d14 0%, #1a1a2e 50%, #0d0d14 100%); padding: 40px;">
      <!-- Header -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 32px; font-weight: 800; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        </div>
        <div style="display: flex; align-items: center; gap: 16px;">
          <span style="font-size: 16px; color: #9ca3af;">${toolCount}+ tools</span>
          <span style="font-size: 14px; color: #6b7280;">mise-tools.jdx.dev</span>
        </div>
      </div>

      ${trendingTools.length > 0 ? `
      <!-- Hot Tools label -->
      <div style="display: flex; align-items: center; margin-bottom: 16px;">
        <span style="color: #fb923c; margin-right: 8px;">🔥</span>
        <span style="font-size: 14px; font-weight: 500; color: #9ca3af;">Hot Tools</span>
        <span style="font-size: 12px; color: #6b7280; margin-left: 8px;">(trending + 30d downloads)</span>
      </div>

      <!-- Tool cards grid (2 rows, 3 cols) -->
      <div style="display: flex; flex-wrap: wrap; gap: 16px;">
        ${toolCardsHtml}
      </div>
      ` : `
      <!-- Fallback content when no trending data -->
      <div style="display: flex; flex-direction: column; flex: 1; justify-content: center;">
        <p style="font-size: 28px; color: #9ca3af; margin: 0; line-height: 1.4;">
          Browse tool versions and download stats for mise
        </p>
      </div>
      `}
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    headers: {
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
    },
  });
};
