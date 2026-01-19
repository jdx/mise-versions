import { useState, useEffect } from "preact/hooks";

export interface VersionTrendData {
  versions: Array<{
    version: string;
    downloads: number;
    share: number;
    trend: "growing" | "declining" | "stable";
  }>;
  timeline: Array<{
    date: string;
    [version: string]: number | string;
  }>;
}

export function useVersionTrends(tool: string, days: number = 30) {
  const [data, setData] = useState<VersionTrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchVersionTrends() {
      try {
        const response = await fetch(
          `/api/downloads/${encodeURIComponent(tool)}/versions?days=${days}`,
        );
        if (!response.ok) {
          throw new Error("Failed to fetch version trends");
        }
        const trendsData = await response.json();
        setData(trendsData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchVersionTrends();
  }, [tool, days]);

  return { data, loading, error };
}
