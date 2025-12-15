import { useState, useEffect } from "preact/hooks";
import { parse } from "smol-toml";

export interface VersionInfo {
  version: string;
  created_at: string | null;
  release_url: string | null;
}

// Convert Date object or string to ISO string
function toISOString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return null;
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
          versions?: Record<
            string,
            { created_at?: unknown; release_url?: string }
          >;
        };
        if (!parsed.versions) {
          setVersions([]);
          return;
        }
        const versionList: VersionInfo[] = Object.entries(parsed.versions)
          .map(([version, data]) => ({
            version,
            created_at: toISOString(data.created_at),
            release_url: data.release_url || null,
          }))
          .reverse();
        setVersions(versionList);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tool]);

  return { versions, loading, error };
}
