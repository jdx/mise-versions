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
