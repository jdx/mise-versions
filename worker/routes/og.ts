// OG Image generation endpoint
import { ImageResponse } from "workers-og";
import { Env, CORS_HEADERS } from "../shared";

interface ToolMeta {
  name: string;
  description?: string;
  latest_version: string;
  version_count: number;
  github?: string;
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

// Generate OG image for a tool
export async function handleOgImage(
  _request: Request,
  _env: Env,
  toolName: string
): Promise<Response> {
  const tool = await getToolMeta(toolName);

  if (!tool) {
    // Return a generic mise tools image for unknown tools
    return generateImage({
      name: toolName,
      description: "Tool not found",
      latest_version: "",
      version_count: 0,
    });
  }

  return generateImage(tool);
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

function generateImage(tool: ToolMeta): Response {
  const description = tool.description
    ? tool.description.length > 100
      ? tool.description.slice(0, 100) + "..."
      : tool.description
    : "";

  const versionText = tool.latest_version
    ? `v${tool.latest_version}`
    : "";

  const countText = tool.version_count > 0
    ? `${tool.version_count} versions`
    : "";

  const html = `
    <div style="display: flex; flex-direction: column; width: 100%; height: 100%; background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%); padding: 60px;">
      <div style="display: flex; flex-direction: column; flex: 1; justify-content: center;">
        <div style="display: flex; align-items: baseline; gap: 20px; margin-bottom: 16px;">
          <span style="font-size: 72px; font-weight: 800; color: #B026FF;">${escapeHtml(tool.name)}</span>
          ${versionText ? `<span style="font-size: 36px; color: #00D4FF; font-family: monospace;">${escapeHtml(versionText)}</span>` : ""}
        </div>
        ${description ? `<p style="font-size: 28px; color: #d1d5db; margin: 0 0 24px 0; line-height: 1.4;">${escapeHtml(description)}</p>` : ""}
        ${countText ? `<p style="font-size: 22px; color: #6b7280; margin: 0;">${escapeHtml(countText)} available via mise</p>` : ""}
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="font-size: 24px; font-weight: 600; background: linear-gradient(90deg, #B026FF, #FF2D95); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">mise tools</span>
        <span style="font-size: 20px; color: #6b7280;">mise-tools.jdx.dev/tools/${escapeHtml(tool.name)}</span>
      </div>
    </div>
  `;

  return new ImageResponse(html, {
    width: 1200,
    height: 630,
    headers: {
      "Cache-Control": "public, max-age=86400", // Cache for 24 hours
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
