// Badge routes: /badge/* - SVG download badges for READMEs
import { drizzle } from "drizzle-orm/d1";
import { Env, CORS_HEADERS } from "../shared";
import { setupAnalytics } from "../../src/analytics";

// Format number for badge display
function formatCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return count.toString();
}

// Calculate text width (approximate, based on character count)
// Using a simple heuristic: average character width is ~7px for 11px font
function measureText(text: string, fontSize: number = 11): number {
  const charWidth = fontSize * 0.6;
  return Math.ceil(text.length * charWidth);
}

// Generate shields.io-style SVG badge
function generateBadgeSvg(
  label: string,
  value: string,
  labelColor: string = "#555",
  valueColor: string = "#4c1"
): string {
  const padding = 10;
  const labelWidth = measureText(label) + padding * 2;
  const valueWidth = measureText(value) + padding * 2;
  const totalWidth = labelWidth + valueWidth;
  const height = 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}">
  <linearGradient id="smooth" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="round">
    <rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#round)">
    <rect width="${labelWidth}" height="${height}" fill="${labelColor}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${valueColor}"/>
    <rect width="${totalWidth}" height="${height}" fill="url(#smooth)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>
    <text x="${labelWidth / 2}" y="14" fill="#fff">${escapeXml(label)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(value)}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="#fff">${escapeXml(value)}</text>
  </g>
</svg>`;
}

// Escape XML special characters
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// SVG response helper
function svgResponse(svg: string, cacheSeconds: number = 3600): Response {
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": `public, max-age=${cacheSeconds}, stale-while-revalidate=86400`,
      ...CORS_HEADERS,
    },
  });
}

// GET /badge/:tool.svg - Total downloads badge
export async function handleBadgeTotal(
  _request: Request,
  env: Env,
  tool: string
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getDownloadStats(tool);
    const count = stats.total || 0;

    const svg = generateBadgeSvg(
      "mise",
      count > 0 ? `${formatCount(count)} downloads` : "no downloads",
      "#555",
      count > 0 ? "#4c1" : "#9f9f9f"
    );

    return svgResponse(svg);
  } catch (error) {
    console.error("Badge error:", error);
    const svg = generateBadgeSvg("mise", "error", "#555", "#e05d44");
    return svgResponse(svg, 60); // Short cache on error
  }
}

// GET /badge/:tool/30d.svg - 30-day downloads badge
export async function handleBadge30d(
  _request: Request,
  env: Env,
  tool: string
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const counts = await analytics.getAll30DayDownloads();
    const count = counts[tool] || 0;

    const svg = generateBadgeSvg(
      "mise/30d",
      count > 0 ? `${formatCount(count)} downloads` : "no downloads",
      "#555",
      count > 0 ? "#007ec6" : "#9f9f9f"
    );

    return svgResponse(svg);
  } catch (error) {
    console.error("Badge 30d error:", error);
    const svg = generateBadgeSvg("mise/30d", "error", "#555", "#e05d44");
    return svgResponse(svg, 60);
  }
}

// GET /badge/:tool/week.svg - 7-day downloads badge
export async function handleBadgeWeek(
  _request: Request,
  env: Env,
  tool: string
): Promise<Response> {
  try {
    const db = drizzle(env.ANALYTICS_DB);
    const analytics = setupAnalytics(db);

    const stats = await analytics.getDownloadStats(tool);
    // Sum last 7 days from daily stats
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split("T")[0];

    let count = 0;
    for (const day of stats.daily || []) {
      if (day.date >= sevenDaysAgoStr) {
        count += day.count;
      }
    }

    const svg = generateBadgeSvg(
      "mise/week",
      count > 0 ? `${formatCount(count)} downloads` : "no downloads",
      "#555",
      count > 0 ? "#97ca00" : "#9f9f9f"
    );

    return svgResponse(svg);
  } catch (error) {
    console.error("Badge week error:", error);
    const svg = generateBadgeSvg("mise/week", "error", "#555", "#e05d44");
    return svgResponse(svg, 60);
  }
}
