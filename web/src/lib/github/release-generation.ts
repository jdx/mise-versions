const LATEST_RELEASE_GENERATION_PREFIX = "github:release-generation:";

interface VersionReleaseData {
  release_url?: string | null;
}

interface ToolReleaseData {
  versions?: VersionReleaseData[];
}

export interface GitHubLatestReleaseGenerations {
  current: string;
  previous?: string;
}

function repositoryFromReleaseUrl(
  releaseUrl: string | null | undefined,
): string | null {
  if (typeof releaseUrl !== "string" || !releaseUrl) return null;

  try {
    const url = new URL(releaseUrl);
    if (
      url.protocol !== "https:" ||
      (url.hostname !== "github.com" && url.hostname !== "www.github.com")
    ) {
      return null;
    }
    const match = url.pathname.match(
      /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/tag\//,
    );
    return match ? `${match[1].toLowerCase()}/${match[2].toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function latestReleaseGenerationKey(owner: string, repo: string): string {
  return `${LATEST_RELEASE_GENERATION_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function validGeneration(value: string | null): value is string {
  return (
    value !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function parseGenerations(
  value: string | null,
): GitHubLatestReleaseGenerations | undefined {
  if (validGeneration(value)) return { current: value };
  if (!value) return undefined;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (!validGenerationValue(record.current)) return undefined;
    return {
      current: record.current,
      previous: validGenerationValue(record.previous)
        ? record.previous
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function validGenerationValue(value: unknown): value is string {
  return typeof value === "string" && validGeneration(value);
}

export async function getGitHubLatestReleaseGenerations(
  cache: KVNamespace,
  owner: string,
  repo: string,
): Promise<GitHubLatestReleaseGenerations | undefined> {
  try {
    return parseGenerations(
      await cache.get(latestReleaseGenerationKey(owner, repo)),
    );
  } catch (error) {
    console.warn(
      `failed to read GitHub latest release generation for ${owner}/${repo}:`,
      error,
    );
    return undefined;
  }
}

export async function rotateGitHubLatestReleaseGenerations(
  cache: KVNamespace,
  tools: ToolReleaseData[],
): Promise<number> {
  const repositories = new Set<string>();
  for (const tool of tools) {
    if (!Array.isArray(tool.versions)) continue;
    for (const version of tool.versions) {
      if (!version || typeof version !== "object") continue;
      const repository = repositoryFromReleaseUrl(version.release_url);
      if (repository) repositories.add(repository);
    }
  }

  for (const repository of repositories) {
    const key = `${LATEST_RELEASE_GENERATION_PREFIX}${repository}`;
    const existing = parseGenerations(await cache.get(key));
    const generations: GitHubLatestReleaseGenerations = {
      current: crypto.randomUUID(),
      previous: existing?.current,
    };
    await cache.put(key, JSON.stringify(generations));
  }
  return repositories.size;
}

export const __testing = {
  latestReleaseGenerationKey,
  parseGenerations,
  repositoryFromReleaseUrl,
  validGeneration,
};
