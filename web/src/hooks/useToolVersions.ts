import { useState, useEffect } from "preact/hooks";
import { parse } from "smol-toml";

export interface VersionInfo {
  version: string;
  created_at: string | null;
}

export function useToolVersions(tool: string) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);

    fetch(`/data/${tool}.toml`)
      .then((res) => {
        if (!res.ok) throw new Error("Tool not found");
        return res.text();
      })
      .then((text) => {
        const parsed = parse(text) as {
          versions?: Record<string, { created_at?: string }>;
        };
        if (!parsed.versions) {
          setVersions([]);
          return;
        }
        const versionList: VersionInfo[] = Object.entries(parsed.versions)
          .map(([version, data]) => ({
            version,
            created_at: data.created_at || null,
          }))
          .reverse();
        setVersions(versionList);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tool]);

  return { versions, loading, error };
}
