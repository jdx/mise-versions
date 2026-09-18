// SQL fragments for the tool directory search: LIKE escaping, the match
// filter, and the relevance ranking that puts an exact name match on top.
//
// All fragments assume the `tools` table is aliased as `t`.

const ESCAPE = "\\";

/** Escape LIKE metacharacters so `c++_` or `100%` is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => ESCAPE + char);
}

// Characters that separate words inside tool names (python-build, ruby_build,
// terraform-ls, aqua:cli/tool). A query matching right after one of these reads
// as a word match rather than an accidental substring hit.
const WORD_SEPARATORS = ["-", "_", ".", "/", ":", "@"];

// Descriptions are only searched for queries at least this long: a one- or
// two-character query matches nearly every description and would bury the
// tools whose *name* matches.
export const DESCRIPTION_MIN_LENGTH = 3;

export interface SearchSql {
  sql: string;
  params: string[];
}

/** Trim/lowercase a raw query; returns "" when there is nothing to search for. */
export function normalizeSearch(search: string | undefined | null): string {
  return (search || "").trim().toLowerCase();
}

/**
 * WHERE fragment selecting the tools that match `query`.
 * Names always match; descriptions only for longer queries.
 */
export function buildSearchFilter(query: string): SearchSql {
  const escaped = escapeLike(query);
  const clauses = [`t.name LIKE ? ESCAPE '${ESCAPE}'`];
  const params = [`%${escaped}%`];

  if (query.length >= DESCRIPTION_MIN_LENGTH) {
    clauses.push(`t.description LIKE ? ESCAPE '${ESCAPE}'`);
    params.push(`%${escaped}%`);
  }

  return { sql: `(${clauses.join(" OR ")})`, params };
}

/**
 * ORDER BY fragment ranking matches by how closely they match, lowest first:
 *
 *   0  exact name        ("oc" -> oc)
 *   1  name prefix       ("oc" -> ocaml)
 *   2  name word start   ("build" -> ruby-build)
 *   3  name substring    ("oc" -> velociraptor)
 *   4  description only  ("kubernetes" -> kubectl)
 *
 * The caller appends its own sort as the tiebreaker within each tier.
 */
export function buildSearchRank(query: string): SearchSql {
  const escaped = escapeLike(query);
  const params: string[] = [];

  const separatorClauses = WORD_SEPARATORS.map((separator) => {
    params.push(`%${escapeLike(separator + query)}%`);
    return `t.name LIKE ? ESCAPE '${ESCAPE}'`;
  });

  // Ordered so that `params` lines up with the `?` placeholders below.
  const exactParam = query;
  const prefixParam = `${escaped}%`;
  const substringParam = `%${escaped}%`;

  return {
    sql: `CASE
      WHEN LOWER(t.name) = ? THEN 0
      WHEN t.name LIKE ? ESCAPE '${ESCAPE}' THEN 1
      WHEN ${separatorClauses.join(" OR ")} THEN 2
      WHEN t.name LIKE ? ESCAPE '${ESCAPE}' THEN 3
      ELSE 4
    END`,
    params: [exactParam, prefixParam, ...params, substringParam],
  };
}
