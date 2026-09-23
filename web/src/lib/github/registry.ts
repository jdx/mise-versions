// What precedes owner/repo in a registry backend that installs from that
// repository's GitHub releases.
const GITHUB_BACKEND_PREFIXES = [
  "aqua:",
  "github:",
  "ubi:",
  "packslip:github.com/",
] as const;

const GITHUB_RELEASE_REPOS = new Set([
  "erlang/otp",
  "erlef/otp_builds",
  "jdx/ruby",
  "oneclick/rubyinstaller2",
]);

const GITHUB_ATTESTATION_REPOS = new Set([
  "astral-sh/python-build-standalone",
  "jdx/ruby",
]);

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
  if (GITHUB_RELEASE_REPOS.has(slug)) {
    return true;
  }

  const exactBackends = GITHUB_BACKEND_PREFIXES.map(
    (prefix) => `${prefix}${slug}`,
  );
  const filteredBackends = [
    ...GITHUB_BACKEND_PREFIXES.map(
      (prefix) => `${prefix}${likeEscape(slug)}[%`,
    ),
    // A packslip project can live in a subdirectory of its repository
    // (packslip:github.com/owner/repo/sub), and its releases are still the
    // repository's.
    `packslip:github.com/${likeEscape(slug)}/%`,
  ];

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
             WHERE lower(b.value) IN (${exactBackends.map(() => "?").join(", ")})
                OR ${filteredBackends.map(() => "lower(b.value) LIKE ? ESCAPE '\\'").join("\n                OR ")}
           )
        LIMIT 1
      `,
    )
    .bind(slug, slug, ...exactBackends, ...filteredBackends)
    .first<{ allowed: number }>();

  return !!row;
}

export function isKnownGitHubAttestationRepo(
  owner: string,
  repo: string,
): boolean {
  return GITHUB_ATTESTATION_REPOS.has(normalizeRepo(owner, repo));
}
