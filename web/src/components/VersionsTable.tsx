import { useState, useMemo } from "preact/hooks";
import { isPrerelease } from "../lib/versions";

interface Version {
  version: string;
  created_at?: string | null;
  release_url?: string | null;
}

type VersionSortKey = "default" | "downloads" | "released";

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function getInterestingPrefixes(versions: Version[]): string[] {
  if (!versions || versions.length === 0) return [];

  // Parse versions and group by major
  const majorGroups = new Map<string, string[]>();
  const minorGroups = new Map<string, string[]>();

  for (const v of versions) {
    const parts = v.version.split(".");
    if (parts.length >= 1) {
      const major = parts[0];
      if (!majorGroups.has(major)) {
        majorGroups.set(major, []);
      }
      majorGroups.get(major)!.push(v.version);

      if (parts.length >= 2) {
        const minor = `${parts[0]}.${parts[1]}`;
        if (!minorGroups.has(minor)) {
          minorGroups.set(minor, []);
        }
        minorGroups.get(minor)!.push(v.version);
      }
    }
  }

  // Decide granularity: use major if 4+, otherwise minor
  const useMajor = majorGroups.size >= 4;
  const groups = useMajor ? majorGroups : minorGroups;

  // Sort by version number descending (newest first)
  const sortedPrefixes = Array.from(groups.keys()).sort((a, b) => {
    const aParts = a.split(".").map(Number);
    const bParts = b.split(".").map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (bVal !== aVal) return bVal - aVal;
    }
    return 0;
  });

  // Limit to 8 pills max
  return sortedPrefixes.slice(0, 8);
}

interface VersionsTableProps {
  versions: Version[];
  downloadsByVersion: Record<string, number>;
}

export function VersionsTable({ versions, downloadsByVersion }: VersionsTableProps) {
  const [sortBy, setSortBy] = useState<VersionSortKey>("default");
  const [versionPrefix, setVersionPrefix] = useState("");
  const [hidePrerelease, setHidePrerelease] = useState(false);

  // Create a map of version -> download count
  const versionDownloads = useMemo(() => {
    return new Map(Object.entries(downloadsByVersion));
  }, [downloadsByVersion]);

  // Sort versions based on selected sort key
  const sortedVersions = useMemo(() => {
    if (!versions) return [];
    if (sortBy === "default") return [...versions].reverse(); // newest first

    return [...versions].sort((a, b) => {
      switch (sortBy) {
        case "downloads":
          return (versionDownloads.get(b.version) || 0) - (versionDownloads.get(a.version) || 0);
        case "released":
          if (!a.created_at && !b.created_at) return 0;
          if (!a.created_at) return 1;
          if (!b.created_at) return -1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        default:
          return 0;
      }
    });
  }, [versions, sortBy, versionDownloads]);

  // Get interesting version prefixes for pill buttons
  const interestingPrefixes = useMemo(() => {
    return getInterestingPrefixes(versions || []);
  }, [versions]);

  // Filter versions by selected prefix and prerelease status
  const filteredVersions = useMemo(() => {
    let result = sortedVersions;
    if (hidePrerelease) {
      result = result.filter((v) => !isPrerelease(v.version));
    }
    if (versionPrefix) {
      result = result.filter((v) => v.version.startsWith(versionPrefix + ".") || v.version === versionPrefix);
    }
    return result;
  }, [sortedVersions, versionPrefix, hidePrerelease]);

  // Count prereleases for display
  const prereleaseCount = useMemo(() => {
    return versions?.filter((v) => isPrerelease(v.version)).length || 0;
  }, [versions]);

  const SortButton = ({ label, sortKey }: { label: string; sortKey: VersionSortKey }) => (
    <button
      onClick={() => setSortBy(sortKey)}
      class={`text-sm font-medium transition-colors ${
        sortBy === sortKey
          ? "text-neon-purple"
          : "text-gray-400 hover:text-gray-200"
      }`}
    >
      {label}
      {sortBy === sortKey && " ↓"}
    </button>
  );

  return (
    <div>
      {/* Filters row */}
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        {/* Version filter pills */}
        {interestingPrefixes.length > 1 ? (
          <div class="flex flex-wrap gap-2">
            <button
              onClick={() => setVersionPrefix("")}
              class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                versionPrefix === ""
                  ? "bg-neon-purple text-white"
                  : "bg-dark-700 text-gray-400 hover:bg-dark-600 hover:text-gray-200"
              }`}
            >
              All
            </button>
            {interestingPrefixes.map((prefix) => (
              <button
                key={prefix}
                onClick={() => setVersionPrefix(prefix)}
                class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                  versionPrefix === prefix
                    ? "bg-neon-purple text-white"
                    : "bg-dark-700 text-gray-400 hover:bg-dark-600 hover:text-gray-200"
                }`}
              >
                {prefix}
              </button>
            ))}
          </div>
        ) : <div />}

        {/* Hide prereleases checkbox */}
        {prereleaseCount > 0 && (
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hidePrerelease}
              onChange={(e) => setHidePrerelease((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-dark-500 bg-dark-700 text-neon-purple focus:ring-neon-purple focus:ring-offset-dark-800"
            />
            Hide prereleases ({prereleaseCount})
          </label>
        )}
      </div>

      {/* Version table */}
      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3">
                <SortButton label="Version" sortKey="default" />
                {versionPrefix && (
                  <span class="ml-2 text-xs text-gray-500">
                    ({filteredVersions.length} of {versions?.length})
                  </span>
                )}
              </th>
              <th class="text-right px-4 py-3 hidden sm:table-cell">
                <SortButton label="Downloads" sortKey="downloads" />
              </th>
              <th class="text-right px-4 py-3">
                <SortButton label="Released" sortKey="released" />
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {filteredVersions.map((v) => (
              <tr key={v.version} class="hover:bg-dark-700 transition-colors">
                <td class="px-4 py-3 font-mono text-sm">
                  {v.release_url ? (
                    <a
                      href={v.release_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-neon-blue hover:text-neon-purple transition-colors"
                    >
                      {v.version}
                    </a>
                  ) : (
                    <span class="text-gray-200">{v.version}</span>
                  )}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell text-right">
                  {(versionDownloads.get(v.version) || 0).toLocaleString()}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400 text-right">
                  {v.created_at ? (
                    <>
                      {formatRelativeTime(v.created_at)}{" "}
                      <span class="text-gray-500">({formatDate(v.created_at)})</span>
                    </>
                  ) : (
                    "-"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
