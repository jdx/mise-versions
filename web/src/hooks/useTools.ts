import { useState, useEffect } from "preact/hooks";

export interface Tool {
  name: string;
  latest_version: string;
  version_count: number;
  last_updated: string | null;
  github?: string;
  description?: string;

  // New metadata fields
  license?: string;
  homepage?: string;
  repo_url?: string;
  authors?: string[];
  backends?: string[];
  aqua_link?: string;
  package_urls?: {
    npm?: string;
    cargo?: string;
    pypi?: string;
    rubygems?: string;
    go?: string;
  };
}

export interface ToolsManifest {
  tool_count: number;
  tools: Tool[];
}

export function useTools() {
  const [data, setData] = useState<ToolsManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/tools.json")
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch tools");
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return { data, loading, error };
}
