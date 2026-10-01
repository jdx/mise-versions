import { useCallback, useEffect, useState } from "preact/hooks";

export interface DownloadDetails {
  monthly: Array<{ month: string; count: number }>;
  byVersion: Array<{ version: string; count: number }>;
  byOs: Array<{ os: string | null; count: number }>;
}

export type DownloadDetailsState =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "error" }
  | { status: "ready"; data: DownloadDetails };

// The downloads panel and the versions table both need these numbers; sharing
// the in-flight request keeps it to one fetch per tool per page load.
const requests = new Map<string, Promise<DownloadDetailsState>>();

function request(tool: string): Promise<DownloadDetailsState> {
  let pending = requests.get(tool);
  if (!pending) {
    pending = fetch(`/api/downloads/${encodeURIComponent(tool)}/details`)
      .then(async (response): Promise<DownloadDetailsState> => {
        if (response.status === 401) return { status: "locked" };
        if (!response.ok) return { status: "error" };
        return {
          status: "ready",
          data: await response.json<DownloadDetails>(),
        };
      })
      .catch((): DownloadDetailsState => ({ status: "error" }));
    requests.set(tool, pending);
  }
  return pending;
}

export function useDownloadDetails(tool: string) {
  const [state, setState] = useState<DownloadDetailsState>({
    status: "loading",
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void request(tool).then((next) => {
      if (!current) return;
      // Do not cache failures, so retrying actually retries.
      if (next.status === "error") requests.delete(tool);
      setState(next);
    });
    return () => {
      current = false;
    };
  }, [tool, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, retry };
}
