import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ params }) => {
  const { tool } = params;

  if (!tool) {
    return new Response('Tool name required', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Validate tool name (alphanumeric, hyphens, underscores, slashes for namespaced tools)
  if (!/^[\w\-\/]+$/.test(tool)) {
    return new Response('Invalid tool name', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  try {
    // Fetch TOML from GitHub Pages
    const response = await fetch(`https://mise-versions.jdx.dev/${tool}.toml`, {
      cf: { cacheTtl: 600 },
    } as RequestInit);

    if (!response.ok) {
      if (response.status === 404) {
        return new Response(`Tool "${tool}" not found`, {
          status: 404,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      throw new Error(`Failed to fetch: ${response.status}`);
    }

    const tomlContent = await response.text();

    return new Response(tomlContent, {
      status: 200,
      headers: {
        'Content-Type': 'application/toml',
        'Cache-Control': 'public, max-age=600',
      },
    });
  } catch (error) {
    console.error('Error fetching TOML:', error);
    return new Response('Failed to fetch tool data', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
