import { useState, useEffect } from "preact/hooks";

export interface BackendStats {
  downloads_by_backend: Array<{ backend: string; count: number }>;
  top_tools_by_backend: Record<string, Array<{ tool: string; count: number }>>;
}

// Returns backend download stats from actual tracking data
export function useBackendStats() {
  const [data, setData] = useState<BackendStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats/backends")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch backend stats");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
