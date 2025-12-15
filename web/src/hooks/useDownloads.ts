import { useState, useEffect } from "preact/hooks";

export interface DownloadStats {
  total: number;
  byVersion: Array<{ version: string; count: number }>;
  byOs: Array<{ os: string | null; count: number }>;
  daily: Array<{ date: string; count: number }>;
  monthly: Array<{ month: string; count: number }>;
}

export function useDownloads(tool: string) {
  const [data, setData] = useState<DownloadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`/api/downloads/${encodeURIComponent(tool)}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch download stats");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tool]);

  return { data, loading, error };
}
