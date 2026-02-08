import type { APIRoute } from "astro";
import { ImageResponse } from "workers-og";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../src/analytics";
import { loadToolsJson, type ToolMeta } from "../../../lib/data-loader";

interface OGToolMeta {
  name: string;
  description?: string;
  latest_version: string;
  version_count: number;
  github?: string;
  backends?: string[];
}

// Get primary backend from backends array (cleaned and truncated)
function getPrimaryBackend(backends?: string[]): string | null {
  if (!backends || backends.length === 0) return null;
  let backend = backends[0];
  const bracketIndex = backend.indexOf("[");
  if (bracketIndex > 0) backend = backend.slice(0, bracketIndex);
  if (backend.length > 35) backend = backend.slice(0, 35) + "...";
  return backend;
}

// Format download count for display
function formatDownloads(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function generateImage(
  tool: OGToolMeta,
  downloads: number | null,
  backend: string | null,
): Response {
  const description = tool.description
    ? tool.description.length > 150
      ? tool.description.slice(0, 150) + "..."
      : tool.description
    : "";

  const versionText = tool.latest_version ? `v${tool.latest_version}` : "";

  const html = `
    <div style="display: flex; flex-direction: column; width: 1200px; height: 630px; background: linear-gradient(135deg, #0d0d14 0%, #1a1a2e 50%, #0d0d14 100%); padding: 40px;">
      <!-- Header -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 28px; font-weight: 800; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        </div>
        <span style="font-size: 14px; color: #6b7280;">mise-tools.jdx.dev</span>
      </div>

      <!-- Tool card (centered, larger version of Hot Tools card style) -->
      <div style="display: flex; flex: 1; align-items: center; justify-content: center;">
        <div style="display: flex; flex-direction: column; background: #1a1a2e; border: 2px solid #2d2d44; border-radius: 16px; padding: 40px; width: 900px; min-height: 380px;">
          <!-- Header row: name + downloads -->
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
            <div style="display: flex; align-items: baseline; gap: 16px;">
              <span style="font-size: 48px; font-weight: 700; color: #f3f4f6;">${escapeHtml(tool.name)}</span>
              ${versionText ? `<span style="font-size: 24px; color: #00D4FF; font-family: monospace;">${escapeHtml(versionText)}</span>` : ""}
            </div>
            ${downloads ? `<span style="font-size: 32px; font-weight: 600; color: #00D4FF;">${formatDownloads(downloads)}</span>` : ""}
          </div>

          <!-- Description -->
          <div style="font-size: 24px; color: #9ca3af; margin-bottom: 32px; line-height: 1.5; flex: 1;">
            ${escapeHtml(description)}
          </div>

          <!-- Footer: badges -->
          <div style="display: flex; align-items: center; gap: 16px;">
            ${backend ? `<span style="font-size: 18px; color: #6b7280; background: #0d0d14; padding: 8px 16px; border-radius: 8px;">${escapeHtml(backend)}</span>` : ""}
            ${tool.version_count > 0 ? `<span style="font-size: 18px; color: #6b7280;">${tool.version_count} versions</span>` : ""}
            ${downloads ? `<span style="font-size: 18px; color: #6b7280;">30d downloads</span>` : ""}
          </div>
        </div>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    headers: {
      "Cache-Control": "public, max-age=86400", // Cache for 24 hours
    },
  });
}

// GET /api/og/:tool - Generate OG image for a tool
export const GET: APIRoute = async ({ params, locals }) => {
  const toolName = params.tool!;
  const runtime = locals.runtime;

  // Fetch tool meta and downloads in parallel
  const [toolsData, downloads] = await Promise.all([
    loadToolsJson(runtime.env.ANALYTICS_DB),
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
    return generateImage(
      {
        name: toolName,
        description: "Tool not found",
        latest_version: "",
        version_count: 0,
      },
      null,
      null,
    );
  }

  const backend = getPrimaryBackend(tool.backends);
  return generateImage(tool, downloads, backend);
};
