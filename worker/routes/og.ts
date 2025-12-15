// OG Image generation endpoint
import { ImageResponse } from "workers-og";
import { drizzle } from "drizzle-orm/d1";
import { Env, CORS_HEADERS } from "../shared";
import { setupAnalytics } from "../../src/analytics";

interface ToolMeta {
  name: string;
  description?: string;
  latest_version: string;
  version_count: number;
  github?: string;
  backends?: string[];
}

// Cache for tools.json to avoid repeated fetches
let toolsCache: { tools: ToolMeta[]; timestamp: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getToolMeta(toolName: string): Promise<ToolMeta | null> {
  const now = Date.now();

  // Use cache if valid
  if (toolsCache && now - toolsCache.timestamp < CACHE_TTL) {
    return toolsCache.tools.find((t) => t.name === toolName) || null;
  }

  try {
    const response = await fetch("https://mise-versions.jdx.dev/tools.json");
    if (!response.ok) return null;
    const data = (await response.json()) as { tools: ToolMeta[] };
    toolsCache = { tools: data.tools, timestamp: now };
    return data.tools.find((t) => t.name === toolName) || null;
  } catch {
    return null;
  }
}

// Fetch download count for a tool
async function getDownloadCount(toolName: string, env: Env): Promise<number | null> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);
    const stats = await analytics.getDownloadStats(toolName);
    return stats.total || null;
  } catch {
    return null;
  }
}

// Get primary backend type from backends array
function getPrimaryBackend(backends?: string[]): string | null {
  if (!backends || backends.length === 0) return null;
  const backend = backends[0];
  const colonIndex = backend.indexOf(":");
  return colonIndex > 0 ? backend.slice(0, colonIndex) : backend;
}

// Format download count for display
function formatDownloads(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return count.toString();
}

// Generate OG image for a tool
export async function handleOgImage(
  _request: Request,
  env: Env,
  toolName: string
): Promise<Response> {
  const [tool, downloads] = await Promise.all([
    getToolMeta(toolName),
    getDownloadCount(toolName, env),
  ]);

  if (!tool) {
    // Return a generic mise tools image for unknown tools
    return generateImage({
      name: toolName,
      description: "Tool not found",
      latest_version: "",
      version_count: 0,
    }, null, null);
  }

  const backend = getPrimaryBackend(tool.backends);
  return generateImage(tool, downloads, backend);
}

// Generate OG image for homepage
export async function handleOgImageHome(
  _request: Request,
  _env: Env
): Promise<Response> {
  const html = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%); padding: 60px;">
      <div style="display: flex; flex-direction: column; flex: 1; justify-content: center;">
        <div style="display: flex; align-items: center; margin-bottom: 24px;">
          <span style="font-size: 72px; font-weight: 800; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        </div>
        <p style="font-size: 32px; color: #9ca3af; margin: 0; line-height: 1.4;">
          Browse tool versions and download stats for mise
        </p>
        <p style="font-size: 24px; color: #6b7280; margin-top: 24px;">
          960+ tools available
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span style="font-size: 20px; color: #6b7280;">mise-tools.jdx.dev</span>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
  });
}

// Mise logo as inline SVG (simplified for Satori compatibility)
const MISE_LOGO = `
<svg width="36" height="36" viewBox="15 25 90 70" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect x="20" y="30" width="80" height="60" rx="8" fill="#1a1a1a" stroke="#00d9ff" stroke-width="3"/>
  <rect x="21.5" y="31.5" width="77" height="16" rx="6" fill="#2a2a2a"/>
  <circle cx="32" cy="39" r="3" fill="#ff5252"/>
  <circle cx="44" cy="39" r="3" fill="#ffbd2e"/>
  <circle cx="56" cy="39" r="3" fill="#52e892"/>
  <rect x="52" y="56" width="35" height="2.5" fill="#00d9ff" opacity="0.7"/>
  <rect x="28" y="74" width="25" height="2.5" fill="#52e892" opacity="0.6"/>
  <rect x="56" y="74" width="18" height="2.5" fill="#ff9100" opacity="0.6"/>
</svg>`;

function generateImage(tool: ToolMeta, downloads: number | null, backend: string | null): Response {
  const description = tool.description
    ? tool.description.length > 120
      ? tool.description.slice(0, 120) + "..."
      : tool.description
    : "";

  const versionText = tool.latest_version ? `v${tool.latest_version}` : "";

  // Build stat badges
  const backendBadge = backend
    ? `<div style="display: flex; align-items: center; background: rgba(0, 212, 255, 0.1); border: 1px solid rgba(0, 212, 255, 0.3); border-radius: 8px; padding: 12px 20px;">
        <span style="font-size: 20px; color: #00D4FF; font-weight: 600;">${escapeHtml(backend)}</span>
       </div>`
    : "";

  const downloadsBadge = downloads
    ? `<div style="display: flex; align-items: center; background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 8px; padding: 12px 20px;">
        <span style="font-size: 20px; color: #22c55e; font-weight: 600;">${formatDownloads(downloads)}</span>
        <span style="font-size: 18px; color: #9ca3af; margin-left: 8px;">downloads</span>
       </div>`
    : "";

  const versionsBadge = tool.version_count > 0
    ? `<div style="display: flex; align-items: center; background: rgba(176, 38, 255, 0.1); border: 1px solid rgba(176, 38, 255, 0.3); border-radius: 8px; padding: 12px 20px;">
        <span style="font-size: 20px; color: #B026FF; font-weight: 600;">${tool.version_count}</span>
        <span style="font-size: 18px; color: #9ca3af; margin-left: 8px;">versions</span>
       </div>`
    : "";

  const html = `
    <div style="display: flex; flex-direction: column; width: 1200px; height: 630px; background: linear-gradient(135deg, #0d0d14 0%, #1a1a2e 50%, #0d0d14 100%); padding: 50px 60px;">
      <!-- Header: branding -->
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 40px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          ${MISE_LOGO}
          <span style="font-size: 24px; font-weight: 700; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        </div>
        <span style="font-size: 18px; color: #4b5563;">mise-tools.jdx.dev</span>
      </div>

      <!-- Main content -->
      <div style="display: flex; flex-direction: column; flex: 1; justify-content: center;">
        <!-- Tool name and version -->
        <div style="display: flex; align-items: baseline; gap: 20px; margin-bottom: 24px;">
          <span style="font-size: 72px; font-weight: 800; color: #B026FF;">${escapeHtml(tool.name)}</span>
          ${versionText ? `<span style="font-size: 32px; color: #00D4FF; font-family: monospace;">${escapeHtml(versionText)}</span>` : ""}
        </div>

        <!-- Description -->
        ${description ? `<p style="font-size: 28px; color: #d1d5db; margin: 0 0 32px 0; line-height: 1.5;">${escapeHtml(description)}</p>` : ""}

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
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
      ...CORS_HEADERS,
    },
  });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
