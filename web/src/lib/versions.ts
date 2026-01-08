/**
 * Version filtering utilities - ported from mise
 * @see https://github.com/jdx/mise/blob/main/src/plugins/mod.rs
 */

/**
 * Regex to identify prerelease/development/unstable versions.
 * Versions matching this pattern should be excluded when showing stable versions.
 *
 * Matches:
 * - -src, -dev, -latest, -stm (build markers)
 * - -rc, .rc (release candidates)
 * - -milestone (milestone releases)
 * - -alpha, -beta (pre-releases)
 * - -pre, .pre (pre-releases)
 * - -next (next version markers)
 * - a1, b2, c3 etc. (single letter + digits)
 * - snapshot, SNAPSHOT (snapshot builds)
 * - master (development branch)
 */
const PRERELEASE_REGEX = /(-src|-dev|-latest|-stm|[-.](rc|pre)|-milestone|-alpha|-beta|-next|([abc])\d+$|snapshot|master)/i;

/**
 * Check if a version string appears to be a prerelease/development version
 */
export function isPrerelease(version: string): boolean {
  return PRERELEASE_REGEX.test(version);
}

/**
 * Filter an array of versions to only include stable releases
 */
export function filterStableVersions<T extends { version: string }>(versions: T[]): T[] {
  return versions.filter(v => !isPrerelease(v.version));
}

/**
 * Get the latest stable version from an array of versions
 * Assumes versions are ordered oldest to newest
 */
export function getLatestStableVersion<T extends { version: string }>(versions: T[]): T | undefined {
  const stable = filterStableVersions(versions);
  return stable[stable.length - 1];
}

/**
 * Distribution detection for tools with multiple implementations
 */

// Distribution patterns for different tools
const DISTRIBUTION_PATTERNS: Record<string, Array<{ prefix: string; name: string }>> = {
  java: [
    { prefix: 'temurin-', name: 'temurin' },
    { prefix: 'graalvm-', name: 'graalvm' },
    { prefix: 'corretto-', name: 'corretto' },
    { prefix: 'liberica-', name: 'liberica' },
    { prefix: 'oracle-', name: 'oracle' },
    { prefix: 'zulu-', name: 'zulu' },
    { prefix: 'jetbrains-', name: 'jetbrains' },
    { prefix: 'dragonwell-', name: 'dragonwell' },
    { prefix: 'semeru-', name: 'semeru' },
    { prefix: 'sapmachine-', name: 'sapmachine' },
    { prefix: 'kona-', name: 'kona' },
    { prefix: 'mandrel-', name: 'mandrel' },
    { prefix: 'microsoft-', name: 'microsoft' },
  ],
  python: [
    { prefix: 'pypy', name: 'pypy' },
    { prefix: 'jython-', name: 'jython' },
    { prefix: 'ironpython-', name: 'ironpython' },
    { prefix: 'graalpy-', name: 'graalpy' },
    { prefix: 'pyston-', name: 'pyston' },
    { prefix: 'stackless-', name: 'stackless' },
    { prefix: 'anaconda', name: 'anaconda' },
    { prefix: 'miniconda', name: 'miniconda' },
    { prefix: 'miniforge', name: 'miniforge' },
    { prefix: 'mambaforge', name: 'mambaforge' },
  ],
  ruby: [
    { prefix: 'jruby-', name: 'jruby' },
    { prefix: 'truffleruby+graalvm-', name: 'truffleruby+graalvm' },
    { prefix: 'truffleruby-', name: 'truffleruby' },
    { prefix: 'mruby-', name: 'mruby' },
    { prefix: 'rbx-', name: 'rubinius' },
    { prefix: 'ree-', name: 'ree' },
  ],
  node: [
    { prefix: 'lts-', name: 'lts' },
    { prefix: 'lts/', name: 'lts' },
  ],
};

// Default distribution names for each tool (versions without a prefix)
const DEFAULT_DISTRIBUTION_NAMES: Record<string, string> = {
  java: 'openjdk',
  python: 'cpython',
  ruby: 'cruby',
  node: 'node',
};

// Default distribution to show on first load (what users see by default)
const DEFAULT_DISTRIBUTIONS: Record<string, string> = {
  java: 'openjdk',
  python: 'cpython',
  ruby: 'cruby',
};

/**
 * Get the distribution name for a version string
 */
export function getDistribution(version: string, tool: string): string {
  const patterns = DISTRIBUTION_PATTERNS[tool] || [];
  const versionLower = version.toLowerCase();

  for (const { prefix, name } of patterns) {
    if (versionLower.startsWith(prefix.toLowerCase())) {
      return name;
    }
  }

  // Return the default distribution name for this tool
  return DEFAULT_DISTRIBUTION_NAMES[tool] || 'default';
}

/**
 * Get all unique distributions present in a list of versions
 */
export function getUniqueDistributions(versions: string[], tool: string): string[] {
  const dists = new Set<string>();
  for (const v of versions) {
    dists.add(getDistribution(v, tool));
  }

  // Sort with default distribution first, then alphabetically
  const defaultDist = DEFAULT_DISTRIBUTION_NAMES[tool];
  return Array.from(dists).sort((a, b) => {
    if (a === defaultDist) return -1;
    if (b === defaultDist) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Get the default distribution to show for a tool (null if tool doesn't have distributions)
 */
export function getDefaultDistribution(tool: string): string | null {
  return DEFAULT_DISTRIBUTIONS[tool] || null;
}

/**
 * Check if a tool has multiple distributions
 */
export function hasDistributions(tool: string): boolean {
  return tool in DISTRIBUTION_PATTERNS;
}
