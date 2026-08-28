export const UPDATE_WORKFLOW_CRON = "7,37 * * * *";

const UPDATE_WORKFLOW_URL =
  "https://api.github.com/repos/jdx/mise-versions/actions/workflows/update.yml/dispatches";

type DispatchFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface WorkflowDispatchResult {
  requestId: string | null;
}

export async function dispatchUpdateWorkflow(
  token: string,
  fetcher: DispatchFetch = fetch,
): Promise<WorkflowDispatchResult> {
  const response = await fetcher(UPDATE_WORKFLOW_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "mise-versions-cloudflare-scheduler",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({ ref: "main" }),
  });

  if (!response.ok) {
    const requestId = response.headers.get("x-github-request-id");
    const requestSuffix = requestId ? `, request ${requestId}` : "";
    throw new Error(
      `GitHub workflow dispatch failed: ${response.status} ${response.statusText}${requestSuffix}`,
    );
  }

  return { requestId: response.headers.get("x-github-request-id") };
}
