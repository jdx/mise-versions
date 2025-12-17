import type { APIRoute } from 'astro';
import { CORS_HEADERS } from '../../lib/api';

// POST /webhooks/github - GitHub webhooks handler
export const POST: APIRoute = async ({ request }) => {
  const eventType = request.headers.get('x-github-event');

  console.log(`Webhook received: ${eventType} event`);

  return new Response('Webhook processed', {
    status: 200,
    headers: CORS_HEADERS,
  });
};
