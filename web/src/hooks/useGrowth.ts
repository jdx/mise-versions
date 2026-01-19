import { useState, useEffect } from "preact/hooks";

export interface GrowthData {
  global: {
    wow: number | null;
    mom: number | null;
    thisWeek: number;
    lastWeek: number;
    thisMonth: number;
    lastMonth: number;
  };
  topGrowing: Array<{
    tool: string;
    thisWeek: number;
    lastWeek: number;
    wow: number | null;
  }>;
  topDeclining: Array<{
    tool: string;
    thisWeek: number;
    lastWeek: number;
    wow: number | null;
  }>;
}

export function useGrowth() {
  const [data, setData] = useState<GrowthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchGrowth() {
      try {
        const response = await fetch("/api/stats/growth");
        if (!response.ok) {
          throw new Error("Failed to fetch growth data");
        }
        const growthData = await response.json();
        setData(growthData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchGrowth();
  }, []);

  return { data, loading, error };
}

export interface ToolGrowthData {
  wow: number | null;
  mom: number | null;
  sparkline: number[];
  thisWeek: number;
  lastWeek: number;
  thisMonth: number;
  lastMonth: number;
}

export function useToolGrowth(tool: string) {
  const [data, setData] = useState<ToolGrowthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchToolGrowth() {
      try {
        const response = await fetch(
          `/api/downloads/${encodeURIComponent(tool)}/growth`,
        );
        if (!response.ok) {
          throw new Error("Failed to fetch tool growth data");
        }
        const growthData = await response.json();
        setData(growthData);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    fetchToolGrowth();
  }, [tool]);

  return { data, loading, error };
}
