import type { APIRoute } from 'astro';

// Proxy aqua-registry requests to raw GitHub for backwards compatibility
// Old clients referenced URLs like https://mise-versions.jdx.dev/aqua-registry/kubernetes/kubectl/registry.yaml
export const GET: APIRoute = async ({ params }) => {
  const path = params.path;

  if (!path) {
    return new Response('Path required', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Proxy to raw GitHub since files are in docs/aqua-registry/
  const rawGithubUrl = `https://raw.githubusercontent.com/jdx/mise-versions/main/docs/aqua-registry/${path}`;

  try {
    const response = await fetch(rawGithubUrl);

    if (!response.ok) {
      return new Response(`File not found: aqua-registry/${path}`, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    const body = await response.text();

    // Determine content type based on file extension
    const contentType = path.endsWith('.yaml') || path.endsWith('.yml')
      ? 'text/yaml; charset=utf-8'
      : 'text/plain; charset=utf-8';

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (error) {
    console.error('Error proxying aqua-registry request:', error);
    return new Response('Failed to fetch file', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
};
