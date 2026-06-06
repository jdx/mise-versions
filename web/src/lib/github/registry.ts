const GITHUB_BACKEND_PREFIXES = ["aqua", "github", "ubi"] as const;

function normalizeRepo(owner: string, repo: string): string {
  return `${owner}/${repo}`.toLowerCase();
}

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function isRegisteredGitHubRepo(
  analyticsDb: D1Database,
  owner: string,
  repo: string,
): Promise<boolean> {
  const slug = normalizeRepo(owner, repo);
  const exactBackends = GITHUB_BACKEND_PREFIXES.map(
    (backend) => `${backend}:${slug}`,
  );
  const filteredBackends = GITHUB_BACKEND_PREFIXES.map(
    (backend) => `${backend}:${likeEscape(slug)}[%`,
  );

  const row = await analyticsDb
    .prepare(
      `
        SELECT 1 AS allowed
        FROM tools t
        WHERE lower(t.github) = ?
           -- Some explicit registry entries use owner/repo as the tool name.
           -- Do not match the repo basename; that would allow unrelated owners.
           OR lower(t.name) = ?
           OR EXISTS (
             SELECT 1
             FROM json_each(t.backends) b
             WHERE lower(b.value) IN (?, ?, ?)
                OR lower(b.value) LIKE ? ESCAPE '\\'
                OR lower(b.value) LIKE ? ESCAPE '\\'
                OR lower(b.value) LIKE ? ESCAPE '\\'
           )
        LIMIT 1
      `,
    )
    .bind(slug, slug, ...exactBackends, ...filteredBackends)
    .first<{ allowed: number }>();

  return !!row;
}
