import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { loadToolsJson } from "../../lib/data-loader";

export const ALGOLIA_TOOLS_PER_PAGE = 150;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export const GET: APIRoute = async ({ params }) => {
  const page = Number.parseInt(params.page ?? "", 10);
  if (!Number.isInteger(page) || page < 1) {
    return new Response("Not found", { status: 404 });
  }

  const data = await loadToolsJson(env.ANALYTICS_DB);
  if (!data) {
    return new Response("Failed to load tools", { status: 500 });
  }

  const start = (page - 1) * ALGOLIA_TOOLS_PER_PAGE;
  const tools = data.tools.slice(start, start + ALGOLIA_TOOLS_PER_PAGE);
  if (tools.length === 0) {
    return new Response("Not found", { status: 404 });
  }

  const records = tools
    .map((tool) => {
      const name = escapeHtml(tool.name);
      const href = escapeHtml(`/tools/${encodeURIComponent(tool.name)}`);
      const description = escapeHtml(tool.description ?? "");
      const backends = escapeHtml(tool.backends?.join(" ") ?? "");
      return `<article class="algolia-tool" data-url="${href}"><h1>${name}</h1><p class="description">${description}</p><p class="backends">${backends}</p><code>mise use ${name}@latest</code></article>`;
    })
    .join("\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>mise tools search feed ${page}</title></head><body><main>${records}</main></body></html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=600, stale-while-revalidate=3600",
    },
  });
};
