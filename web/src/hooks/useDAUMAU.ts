import { useState, useEffect } from "preact/hooks";

export interface DAUMAUData {
  daily: Array<{ date: string; dau: number }>;
  current_mau: number;
}

export function useDAUMAU() {
  const [data, setData] = useState<DAUMAUData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats/dau-mau")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch DAU/MAU stats");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
