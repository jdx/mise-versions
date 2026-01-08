import { useState, useMemo, useCallback } from "preact/hooks";
import {
  isPrerelease,
  getDistribution,
  getUniqueDistributions,
  getDefaultDistribution,
  hasDistributions,
} from "../lib/versions";

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

function getInterestingPrefixes(versions: Version[], tool?: string, distribution?: string): string[] {
  if (!versions || versions.length === 0) return [];

  // Filter to current distribution first if specified
  let filteredVersions = versions;
  if (distribution && tool) {
    filteredVersions = versions.filter((v) => getDistribution(v.version, tool) === distribution);
  }

  // Parse versions and group by major
  const majorGroups = new Map<string, string[]>();
  const minorGroups = new Map<string, string[]>();

  for (const v of filteredVersions) {
    // Strip distribution prefix for version grouping
    let versionStr = v.version;
    if (tool && distribution) {
      const dist = getDistribution(v.version, tool);
      if (dist !== "default" && dist !== "openjdk" && dist !== "cpython" && dist !== "cruby" && dist !== "node") {
        // Remove the prefix for cleaner grouping
        const idx = v.version.indexOf("-");
        if (idx > 0) {
          versionStr = v.version.substring(idx + 1);
        }
      }
    }

    const parts = versionStr.split(".");
    if (parts.length >= 1 && /^\d/.test(parts[0])) {
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
  github?: string;
  tool?: string;
}

// Construct release URL from github slug and version
function buildReleaseUrl(github: string, version: string): string {
  // Try common tag patterns: v1.0.0 is most common
  return `https://github.com/${github}/releases/tag/v${version}`;
}

// Debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useMemo(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);
    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

const ITEMS_PER_PAGE = 100;

export function VersionsTable({ versions, downloadsByVersion, github, tool }: VersionsTableProps) {
  // Initialize distribution to default for this tool (if it has distributions)
  const defaultDist = tool ? getDefaultDistribution(tool) : null;
  const toolHasDistributions = tool ? hasDistributions(tool) : false;

  const [sortBy, setSortBy] = useState<VersionSortKey>("default");
  const [versionPrefix, setVersionPrefix] = useState("");
  const [hidePrerelease, setHidePrerelease] = useState(false);
  const [distribution, setDistribution] = useState(defaultDist || "");
  const [searchQuery, setSearchQuery] = useState("");
  const [displayCount, setDisplayCount] = useState(ITEMS_PER_PAGE);

  // Debounce search query
  const debouncedSearch = useDebounce(searchQuery, 300);

  // Create a map of version -> download count
  const versionDownloads = useMemo(() => {
    return new Map(Object.entries(downloadsByVersion));
  }, [downloadsByVersion]);

  // Get unique distributions for this tool
  const distributions = useMemo(() => {
    if (!tool || !toolHasDistributions) return [];
    return getUniqueDistributions(
      versions?.map((v) => v.version) || [],
      tool
    );
  }, [versions, tool, toolHasDistributions]);

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

  // Get interesting version prefixes for pill buttons (based on current distribution)
  const interestingPrefixes = useMemo(() => {
    return getInterestingPrefixes(versions || [], tool, distribution || undefined);
  }, [versions, tool, distribution]);

  // Filter versions by all criteria
  const filteredVersions = useMemo(() => {
    let result = sortedVersions;

    // Filter by distribution
    if (distribution && tool) {
      result = result.filter((v) => getDistribution(v.version, tool) === distribution);
    }

    // Filter by search query
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      result = result.filter((v) => v.version.toLowerCase().includes(q));
    }

    // Filter by prerelease
    if (hidePrerelease) {
      result = result.filter((v) => !isPrerelease(v.version));
    }

    // Filter by version prefix
    if (versionPrefix) {
      result = result.filter((v) => {
        // For prefixed distributions, check the numeric part
        let versionStr = v.version;
        if (tool) {
          const dist = getDistribution(v.version, tool);
          if (dist !== "default" && dist !== "openjdk" && dist !== "cpython" && dist !== "cruby" && dist !== "node") {
            const idx = v.version.indexOf("-");
            if (idx > 0) {
              versionStr = v.version.substring(idx + 1);
            }
          }
        }
        return versionStr.startsWith(versionPrefix + ".") || versionStr === versionPrefix;
      });
    }

    return result;
  }, [sortedVersions, distribution, debouncedSearch, hidePrerelease, versionPrefix, tool]);

  // Paginated versions
  const displayedVersions = filteredVersions.slice(0, displayCount);
  const hasMore = filteredVersions.length > displayCount;

  // Reset pagination when filters change
  const handleFilterChange = useCallback(() => {
    setDisplayCount(ITEMS_PER_PAGE);
  }, []);

  // Count prereleases for display (in current distribution)
  const prereleaseCount = useMemo(() => {
    let result = versions || [];
    if (distribution && tool) {
      result = result.filter((v) => getDistribution(v.version, tool) === distribution);
    }
    return result.filter((v) => isPrerelease(v.version)).length;
  }, [versions, distribution, tool]);

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

  const FilterPill = ({
    label,
    active,
    onClick,
  }: {
    label: string;
    active: boolean;
    onClick: () => void;
  }) => (
    <button
      onClick={() => {
        onClick();
        handleFilterChange();
      }}
      class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
        active
          ? "bg-neon-purple text-white"
          : "bg-dark-700 text-gray-400 hover:bg-dark-600 hover:text-gray-200"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      {/* Search and hide prereleases row */}
      <div class="flex flex-wrap items-center justify-between gap-4 mb-4">
        {/* Search input */}
        <div class="relative flex-1 min-w-[200px] max-w-md">
          <input
            type="text"
            value={searchQuery}
            onInput={(e) => {
              setSearchQuery((e.target as HTMLInputElement).value);
              handleFilterChange();
            }}
            placeholder="Search versions..."
            class="w-full px-4 py-2 pl-10 bg-dark-700 border border-dark-600 rounded-lg text-gray-200 placeholder-gray-500 focus:outline-none focus:border-neon-purple focus:ring-1 focus:ring-neon-purple text-sm"
          />
          <svg
            class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
        </div>

        {/* Hide prereleases checkbox */}
        {prereleaseCount > 0 && (
          <label class="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none whitespace-nowrap">
            <input
              type="checkbox"
              checked={hidePrerelease}
              onChange={(e) => {
                setHidePrerelease((e.target as HTMLInputElement).checked);
                handleFilterChange();
              }}
              class="w-4 h-4 rounded border-dark-500 bg-dark-700 text-neon-purple focus:ring-neon-purple focus:ring-offset-dark-800"
            />
            Hide prereleases ({prereleaseCount})
          </label>
        )}
      </div>

      {/* Distribution filter pills */}
      {toolHasDistributions && distributions.length > 1 && (
        <div class="mb-4">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-sm text-gray-500 mr-1">Distribution:</span>
            <FilterPill
              label="All"
              active={distribution === ""}
              onClick={() => setDistribution("")}
            />
            {distributions.map((dist) => (
              <FilterPill
                key={dist}
                label={dist}
                active={distribution === dist}
                onClick={() => setDistribution(dist)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Version prefix filter pills */}
      {interestingPrefixes.length > 1 && (
        <div class="flex flex-wrap items-center gap-2 mb-4">
          <span class="text-sm text-gray-500 mr-1">Version:</span>
          <FilterPill
            label="All"
            active={versionPrefix === ""}
            onClick={() => setVersionPrefix("")}
          />
          {interestingPrefixes.map((prefix) => (
            <FilterPill
              key={prefix}
              label={prefix}
              active={versionPrefix === prefix}
              onClick={() => setVersionPrefix(prefix)}
            />
          ))}
        </div>
      )}

      {/* Version table */}
      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3">
                <SortButton label="Version" sortKey="default" />
                <span class="ml-2 text-xs text-gray-500">
                  ({filteredVersions.length.toLocaleString()}{" "}
                  {filteredVersions.length !== versions?.length && `of ${versions?.length.toLocaleString()}`})
                </span>
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
            {displayedVersions.map((v) => (
              <tr key={v.version} class="hover:bg-dark-700 transition-colors">
                <td class="px-4 py-3 font-mono text-sm">
                  {(() => {
                    const url = v.release_url || (github ? buildReleaseUrl(github, v.version) : null);
                    return url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-neon-blue hover:text-neon-purple transition-colors"
                      >
                        {v.version}
                      </a>
                    ) : (
                      <span class="text-gray-200">{v.version}</span>
                    );
                  })()}
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

        {/* Load more button */}
        {hasMore && (
          <div class="border-t border-dark-600 p-4 text-center">
            <button
              onClick={() => setDisplayCount((c) => c + ITEMS_PER_PAGE)}
              class="px-6 py-2 bg-dark-700 hover:bg-dark-600 text-gray-300 hover:text-white rounded-lg transition-colors text-sm"
            >
              Load more (showing {displayedVersions.length.toLocaleString()} of{" "}
              {filteredVersions.length.toLocaleString()})
            </button>
          </div>
        )}

        {/* No results message */}
        {filteredVersions.length === 0 && (
          <div class="p-8 text-center text-gray-500">
            No versions found matching your filters
          </div>
        )}
      </div>
    </div>
  );
}
