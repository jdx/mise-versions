import { useState, useEffect } from "preact/hooks";
import { useAuth } from "./useAuth";

export interface GithubRepoInfo {
  description: string | null;
  homepage: string | null;
  license: string | null;
  stars: number;
  topics: string[];
  // Additional metadata
  forks: number;
  open_issues: number;
  watchers: number;
  pushed_at: string | null;
  created_at: string | null;
  language: string | null;
  archived: boolean;
  default_branch: string;
}

interface UseGithubRepoResult {
  data: GithubRepoInfo | null;
  loading: boolean;
  error: string | null;
}

export function useGithubRepo(
  owner: string | null,
  repo: string | null
): UseGithubRepoResult {
  const { authenticated, loading: authLoading } = useAuth();
  const [data, setData] = useState<GithubRepoInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !authenticated || !owner || !repo) {
      setData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/github/repo?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`)
      .then((res) => {
        if (!res.ok) {
          if (res.status === 401) {
            throw new Error("Not authenticated");
          }
          throw new Error("Failed to fetch repo info");
        }
        return res.json();
      })
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [authenticated, authLoading, owner, repo]);

  return { data, loading, error };
}

// Helper to parse GitHub URL or slug into owner/repo
export function parseGithubSlug(slug: string | null): { owner: string; repo: string } | null {
  if (!slug) return null;

  // Handle full URLs like https://github.com/owner/repo
  const urlMatch = slug.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, "") };
  }

  // Handle owner/repo format
  const slashMatch = slug.match(/^([^/]+)\/([^/]+)$/);
  if (slashMatch) {
    return { owner: slashMatch[1], repo: slashMatch[2] };
  }

  return null;
}
