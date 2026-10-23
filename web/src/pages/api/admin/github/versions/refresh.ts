import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, requireApiAuth } from "../../../../../lib/api";
import { refreshVersionLists } from "../../../../../lib/github/versions";
import { dispatchDeployWorkflow } from "../../../../../../../src/workflow-dispatch";

// POST /api/admin/github/versions/refresh
// One run of the GitHub version-list refresher. The Worker's */10 cron calls
// it in-process (src/worker.ts); it can also be run by hand.
export const POST: APIRoute = async ({ request }) => {
  const authError = requireApiAuth(request, env.API_SECRET);
  if (authError) return authError;
  const run = await refreshVersionLists(env, {
    dispatch: () => dispatchDeployWorkflow(env.GITHUB_ACTIONS_TOKEN),
  });
  return jsonResponse(run);
};
