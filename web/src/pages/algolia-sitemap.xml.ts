import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadToolsJson } from "../lib/data-loader";
import { ALGOLIA_TOOLS_PER_PAGE } from "./algolia-tools/[page]";

const ORIGIN = "https://mise-versions.jdx.dev";

export const GET: APIRoute = async () => {
  const data = await loadToolsJson(env.ANALYTICS_DB);
  if (!data) {
    return new Response("Failed to load tools", { status: 500 });
  }

  const pageCount = Math.ceil(data.tool_count / ALGOLIA_TOOLS_PER_PAGE);
  const urls = Array.from(
    { length: pageCount },
    (_, index) => `<url><loc>${ORIGIN}/algolia-tools/${index + 1}</loc></url>`,
  ).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
    },
  });
};
