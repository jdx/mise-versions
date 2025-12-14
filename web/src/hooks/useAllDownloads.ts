import { useState, useEffect } from "preact/hooks";

// Returns a map of tool name -> 30-day download count
export function useAllDownloads() {
  const [data, setData] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/downloads/30d")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch download stats");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
