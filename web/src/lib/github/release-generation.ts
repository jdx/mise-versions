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
    (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ) ||
      /^[0-9a-f]{64}$/i.test(value))
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

function hasUsableRelease(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value) as {
      data?: { assets?: unknown[] };
    };
    return Array.isArray(parsed.data?.assets) && parsed.data.assets.length > 0;
  } catch {
    return false;
  }
}

async function generationForReleaseUrls(
  releaseUrls: Set<string>,
): Promise<string> {
  const input = new TextEncoder().encode(
    JSON.stringify([...releaseUrls].sort()),
  );
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  const repositories = new Map<string, Set<string>>();
  for (const tool of tools) {
    if (!Array.isArray(tool.versions)) continue;
    for (const version of tool.versions) {
      if (!version || typeof version !== "object") continue;
      const repository = repositoryFromReleaseUrl(version.release_url);
      if (!repository || typeof version.release_url !== "string") continue;
      const releaseUrls = repositories.get(repository) ?? new Set<string>();
      releaseUrls.add(version.release_url);
      repositories.set(repository, releaseUrls);
    }
  }

  for (const [repository, releaseUrls] of repositories) {
    const key = `${LATEST_RELEASE_GENERATION_PREFIX}${repository}`;
    const existing = parseGenerations(await cache.get(key));
    const current = await generationForReleaseUrls(releaseUrls);
    if (existing?.current === current) continue;
    let previous = existing?.previous;
    if (existing) {
      const outgoingRelease = await cache.get(
        `github:release:${repository}:latest:${existing.current}`,
      );
      if (hasUsableRelease(outgoingRelease)) previous = existing.current;
    }
    const generations: GitHubLatestReleaseGenerations = {
      current,
      previous,
    };
    await cache.put(key, JSON.stringify(generations));
  }
  return repositories.size;
}

export const __testing = {
  generationForReleaseUrls,
  hasUsableRelease,
  latestReleaseGenerationKey,
  parseGenerations,
  repositoryFromReleaseUrl,
  validGeneration,
};
