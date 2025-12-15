// Proxy and static asset handling
import { Env, CORS_HEADERS, CACHE_CONTROL } from "./shared";

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
    // Return with original URL so client-side router works
    return new Response(indexResponse.body, {
      status: 200,
      headers: indexResponse.headers,
    });
  }
  return assetResponse;
}
