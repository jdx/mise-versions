// POST /webhooks/github - GitHub webhooks handler
import type { Env, PagesContext } from "../_shared";
import { CORS_HEADERS } from "../_shared";

export const onRequestPost: PagesFunction<Env> = async (context: PagesContext) => {
  const { request } = context;

  const payload = await request.text();
  const eventType = request.headers.get("x-github-event");

  console.log(`Webhook received: ${eventType} event`);

  return new Response("Webhook processed", {
    status: 200,
    headers: CORS_HEADERS,
  });
};
