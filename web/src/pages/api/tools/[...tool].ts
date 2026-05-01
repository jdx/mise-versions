import type { APIRoute } from "astro";
import { trackDownloadRequest } from "../track";

export const POST: APIRoute = async ({ request, locals, params }) => {
  return trackDownloadRequest({
    request,
    locals,
    tool: params.tool,
    source: "api/tools/:tool",
  });
};
