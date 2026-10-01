import type { APIRoute } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { setupAnalytics } from "../../../../../../src/analytics";
import { env } from "cloudflare:workers";
import { privateJson, requireSession } from "../../../../lib/session";

// GET /api/downloads/<tool>/details - the download breakdowns that are shown
// to signed-in users only: 12 months, per version and per platform.
export const GET: APIRoute = async ({ params, request }) => {
  const session = await requireSession(request, env.API_SECRET);
  if (session instanceof Response) return session;

  const { tool } = params;
  if (!tool) return privateJson({ error: "Tool name required" }, 400);

  try {
    const analytics = setupAnalytics(drizzle(env.ANALYTICS_DB));
    return privateJson(await analytics.getDownloadBreakdowns(tool));
  } catch (error) {
    console.error("Get download details error:", error);
    return privateJson({ error: "Failed to get download details" }, 500);
  }
};
