// Proxy and static asset handling
import { Env, CORS_HEADERS, CACHE_CONTROL } from "./shared";

// Bot user agents that need OG meta tags
const BOT_USER_AGENTS = [
  "Slackbot",
  "Slack-ImgProxy",
  "Discordbot",
  "Twitterbot",
  "facebookexternalhit",
  "LinkedInBot",
  "WhatsApp",
  "TelegramBot",
  "Googlebot",
  "bingbot",
];

// Check if request is from a bot
function isBot(request: Request): boolean {
  const ua = request.headers.get("user-agent") || "";
  return BOT_USER_AGENTS.some((bot) => ua.includes(bot));
}

// Extract tool name from URL path
function getToolFromPath(pathname: string): string | null {
  // Match /tools/{toolname}
  const match = pathname.match(/^\/tools\/([^/]+)\/?$/);
  if (match) {
    return match[1];
  }
  return null;
}

interface ToolMeta {
  name: string;
  description?: string;
  latest_version: string;
  version_count: number;
  backends?: string[];
}

// Fetch tool metadata from tools.json
async function fetchToolMeta(toolName: string): Promise<ToolMeta | null> {
  try {
    const response = await fetch("https://mise-versions.jdx.dev/tools.json");
    if (!response.ok) return null;
    const data = await response.json() as { tools: ToolMeta[] };
    return data.tools.find((t) => t.name === toolName) || null;
  } catch {
    return null;
  }
}

// Fetch download count for a tool
async function fetchDownloadCount(toolName: string): Promise<number | null> {
  try {
    const response = await fetch(`https://mise-tools.jdx.dev/api/downloads?tool=${encodeURIComponent(toolName)}`);
    if (!response.ok) return null;
    const data = await response.json() as { total: number };
    return data.total || null;
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

// Inject dynamic OG meta tags into HTML
function injectOgTags(html: string, tool: ToolMeta, url: string, downloads: number | null): string {
  const title = `${tool.name} - mise tools`;
  const backend = getPrimaryBackend(tool.backends);

  // Build description parts
  const parts: string[] = [];
  if (tool.description) {
    parts.push(tool.description);
  }
  if (backend) {
    parts.push(`Backend: ${backend}`);
  }
  if (downloads) {
    parts.push(`${formatDownloads(downloads)} downloads`);
  }
  parts.push(`${tool.version_count} versions`);

  const description = parts.join(" · ");

  // Dynamic OG image URL
  const ogImageUrl = `https://mise-tools.jdx.dev/api/og/${encodeURIComponent(tool.name)}`;

  // Replace existing OG tags with dynamic ones
  const replacements: [RegExp, string][] = [
    [/<title>[^<]*<\/title>/, `<title>${title}</title>`],
    [/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(description)}" />`],
    [/<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${escapeHtml(title)}" />`],
    [/<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${escapeHtml(description)}" />`],
    [/<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${escapeHtml(url)}" />`],
    [/<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${escapeHtml(ogImageUrl)}" />`],
    [/<meta name="twitter:title"[^>]*>/, `<meta name="twitter:title" content="${escapeHtml(title)}" />`],
    [/<meta name="twitter:description"[^>]*>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`],
    [/<meta name="twitter:url"[^>]*>/, `<meta name="twitter:url" content="${escapeHtml(url)}" />`],
    [/<meta name="twitter:image"[^>]*>/, `<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />`],
  ];

  for (const [pattern, replacement] of replacements) {
    html = html.replace(pattern, replacement);
  }

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Proxy /data/* to mise-versions.jdx.dev (GitHub Pages)
export async function handleDataProxy(
  _request: Request,
  env: Env,
  params: Record<string, string>
): Promise<Response> {
  const dataPath = params["*"] || "";
  const dataUrl = `https://mise-versions.jdx.dev/${dataPath}`;
  const response = await fetch(dataUrl);

  // Return with CORS headers, only cache successful responses
  const headers: Record<string, string> = {
    ...Object.fromEntries(response.headers),
    ...CORS_HEADERS,
  };
  if (response.ok) {
    headers["Cache-Control"] = CACHE_CONTROL.STATIC;
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

// Serve static assets with SPA fallback to index.html
export async function handleStaticAssets(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const assetResponse = await env.ASSETS.fetch(request);

  if (assetResponse.status === 404) {
    // SPA fallback: serve index.html for client-side routing
    // Fetch "/" since assets binding redirects /index.html to /
    const indexUrl = new URL("/", url);
    const indexResponse = await env.ASSETS.fetch(indexUrl.toString());

    // Check if this is a bot requesting a tool page
    const toolName = getToolFromPath(url.pathname);
    if (toolName && isBot(request)) {
      // Fetch tool metadata and download count in parallel
      const [toolMeta, downloads] = await Promise.all([
        fetchToolMeta(toolName),
        fetchDownloadCount(toolName),
      ]);
      if (toolMeta) {
        const html = await indexResponse.text();
        const modifiedHtml = injectOgTags(html, toolMeta, url.href, downloads);
        return new Response(modifiedHtml, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "public, max-age=300", // Cache for 5 min for bots
          },
        });
      }
    }

    // Return with original URL so client-side router works
    return new Response(indexResponse.body, {
      status: 200,
      headers: indexResponse.headers,
    });
  }
  return assetResponse;
}
