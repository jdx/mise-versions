import { useState, useMemo, useEffect, useRef } from "preact/hooks";

const MAX_SUGGESTIONS = 8;

type SortKey = "name" | "downloads" | "updated";

const VALID_SORT_KEYS: SortKey[] = ["name", "downloads", "updated"];

interface Tool {
  name: string;
  latest_version: string;
  latest_stable_version?: string;
  version_count: number;
  last_updated: string | null;
  description?: string;
  backends?: string[];
  github?: string;
}

interface TrendingTool {
  name: string;
  downloads_30d: number;
  trendingScore: number;
  dailyBoost: number;
  sparkline: number[];
}

interface Props {
  tools: Tool[];
  downloads: Record<string, number>;
  trendingTools?: TrendingTool[];
}

// Mini sparkline SVG component
function Sparkline({ data, color = "#B026FF" }: { data: number[]; color?: string }) {
  if (!data || data.length === 0) return null;

  const max = Math.max(...data, 1);
  const width = 80;
  const height = 24;
  const padding = 2;

  const points = data.map((value, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2);
    const y = height - padding - (value / max) * (height - padding * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={width} height={height} class="opacity-60 group-hover:opacity-100 transition-opacity">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

// Format relative time
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} years ago`;
}

// Extract backend type from backend string
function getBackendType(backend: string): string {
  const colonIndex = backend.indexOf(":");
  return colonIndex > 0 ? backend.slice(0, colonIndex) : backend;
}

// Parse URL params for initial state
function getInitialState() {
  if (typeof window === 'undefined') return { search: '', sortBy: 'downloads' as SortKey, selectedBackends: new Set<string>() };
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q") || "";
  const sort = params.get("sort") as SortKey;
  const backends = params.get("backends");
  return {
    search: q,
    sortBy: VALID_SORT_KEYS.includes(sort) ? sort : "downloads" as SortKey,
    selectedBackends: backends ? new Set(backends.split(",").filter(Boolean)) : new Set<string>(),
  };
}

export function ToolSearch({ tools, downloads, trendingTools = [] }: Props) {
  const initial = getInitialState();
  const [search, setSearch] = useState(initial.search);
  const [sortBy, setSortBy] = useState<SortKey>(initial.sortBy);
  const [selectedBackends, setSelectedBackends] = useState<Set<string>>(initial.selectedBackends);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);

  // Autocomplete suggestions
  const suggestions = useMemo(() => {
    if (!tools || !search.trim()) return [];
    const query = search.toLowerCase();
    return tools
      .filter((t) => t.name.toLowerCase().includes(query))
      .slice(0, MAX_SUGGESTIONS);
  }, [tools, search]);

  useEffect(() => {
    // Auto-select first suggestion when searching
    setSelectedIndex(suggestions.length > 0 ? 0 : -1);
  }, [suggestions]);

  // Sync state to URL
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (sortBy !== "downloads") params.set("sort", sortBy);
    if (selectedBackends.size > 0) params.set("backends", [...selectedBackends].join(","));

    const newUrl = params.toString()
      ? `${window.location.pathname}?${params.toString()}`
      : window.location.pathname;

    window.history.replaceState(null, "", newUrl);
  }, [search, sortBy, selectedBackends]);

  // Compute backend counts for filter chips
  const backendCounts = useMemo(() => {
    if (!tools) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const tool of tools) {
      if (tool.backends) {
        const seenTypes = new Set<string>();
        for (const backend of tool.backends) {
          const backendType = getBackendType(backend);
          if (!seenTypes.has(backendType)) {
            seenTypes.add(backendType);
            counts.set(backendType, (counts.get(backendType) || 0) + 1);
          }
        }
      }
    }
    return new Map([...counts.entries()].sort((a, b) => b[1] - a[1]));
  }, [tools]);

  const filteredTools = useMemo(() => {
    if (!tools) return [];
    let toolsWithDownloads = tools.map((t) => ({
      ...t,
      downloads_30d: downloads?.[t.name] || 0,
    }));

    if (search.trim()) {
      const query = search.toLowerCase();
      toolsWithDownloads = toolsWithDownloads.filter((t) =>
        t.name.toLowerCase().includes(query)
      );
    }

    if (selectedBackends.size > 0) {
      toolsWithDownloads = toolsWithDownloads.filter((t) => {
        if (!t.backends) return false;
        return t.backends.some((backend) =>
          selectedBackends.has(getBackendType(backend))
        );
      });
    }

    return [...toolsWithDownloads].sort((a, b) => {
      switch (sortBy) {
        case "downloads":
          return b.downloads_30d - a.downloads_30d;
        case "updated":
          if (!a.last_updated && !b.last_updated) return 0;
          if (!a.last_updated) return 1;
          if (!b.last_updated) return -1;
          return new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime();
        case "name":
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [tools, downloads, search, sortBy, selectedBackends]);

  const toggleBackend = (backend: string) => {
    setSelectedBackends((prev) => {
      const next = new Set(prev);
      if (next.has(backend)) next.delete(backend);
      else next.add(backend);
      return next;
    });
  };

  const clearFilters = () => setSelectedBackends(new Set());

  const clearSearch = () => {
    setSearch("");
    setShowSuggestions(false);
    searchRef.current?.focus();
  };

  const handleSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      clearSearch();
      return;
    }
    if (!showSuggestions || suggestions.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          window.location.href = `/tools/${suggestions[selectedIndex].name}`;
        }
        break;
    }
  };

  const selectSuggestion = (name: string) => {
    window.location.href = `/tools/${name}`;
  };

  // Merge trending tools with tool metadata
  const hotTools = useMemo(() => {
    if (!tools || trendingTools.length === 0) return [];
    const toolMap = new Map(tools.map(t => [t.name, t]));
    return trendingTools
      .map(t => {
        const meta = toolMap.get(t.name);
        return meta ? { ...meta, ...t } : null;
      })
      .filter((t): t is Tool & TrendingTool => t !== null);
  }, [tools, trendingTools]);

  const SortButton = ({ label, sortKey }: { label: string; sortKey: SortKey }) => (
    <button
      onClick={() => setSortBy(sortKey)}
      class={`text-sm font-medium transition-colors ${
        sortBy === sortKey ? "text-neon-purple" : "text-gray-400 hover:text-gray-200"
      }`}
    >
      {label}
      {sortBy === sortKey && " ↓"}
    </button>
  );

  const HighlightedName = ({ name }: { name: string }) => {
    const query = search.trim().toLowerCase();
    if (!query) return <>{name}</>;
    const index = name.toLowerCase().indexOf(query);
    if (index === -1) return <>{name}</>;
    return (
      <>
        {name.slice(0, index)}
        <span class="text-neon-purple font-semibold">{name.slice(index, index + query.length)}</span>
        {name.slice(index + query.length)}
      </>
    );
  };

  return (
    <div>
      {/* Hot Tools Section */}
      {hotTools.length > 0 && !search.trim() && selectedBackends.size === 0 && (
        <div class="mb-8">
          <h2 class="text-sm font-medium text-gray-400 mb-4 flex items-center gap-2">
            <span class="text-orange-400">🔥</span> Hot Tools
            <span class="text-xs text-gray-500">(trending + 30d downloads)</span>
          </h2>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {hotTools.map((tool, index) => (
              <a
                key={tool.name}
                href={`/tools/${tool.name}`}
                class="bg-dark-800 border border-dark-600 rounded-lg p-4 hover:border-neon-purple/50 hover:bg-dark-700 transition-all group"
              >
                <div class="flex items-start justify-between mb-2">
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-500 font-mono bg-dark-700 px-1.5 py-0.5 rounded">#{index + 1}</span>
                    <span class="text-base font-semibold text-gray-100 group-hover:text-neon-purple transition-colors">
                      {tool.name}
                    </span>
                    {tool.dailyBoost > 40 && <span class="text-orange-400" title="Hot! 1.4x+ recent activity">🔥</span>}
                    {tool.dailyBoost > 20 && tool.dailyBoost <= 40 && <span class="text-green-400" title="Trending 1.2x+ recent activity">↑</span>}
                  </div>
                  <span class="text-sm font-semibold text-neon-blue">{(tool.downloads_30d / 1000).toFixed(1)}k</span>
                </div>
                <div class="text-sm text-gray-400 group-hover:text-gray-300 transition-colors line-clamp-2 mb-3 min-h-[2.5rem]">
                  {tool.description || ""}
                </div>
                <div class="flex items-center justify-between">
                  <div class="flex items-center gap-2">
                    {tool.backends && tool.backends[0] && (
                      <span class="px-2 py-0.5 rounded text-xs bg-dark-700 text-gray-500">
                        {getBackendType(tool.backends[0])}
                      </span>
                    )}
                    <span class="text-xs text-gray-500">{tool.version_count} versions</span>
                  </div>
                  {tool.sparkline && <Sparkline data={tool.sparkline} />}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      <div class="mb-4 flex items-center justify-between gap-4">
        <div class="relative w-full max-w-md">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search tools..."
            value={search}
            onInput={(e) => {
              setSearch((e.target as HTMLInputElement).value);
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            onKeyDown={handleSearchKeyDown}
            class="w-full px-4 py-2 pr-10 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-neon-purple focus:ring-1 focus:ring-neon-purple"
            autocomplete="off"
          />
          {search && (
            <button
              type="button"
              onClick={clearSearch}
              class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
              title="Clear search (Esc)"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          {showSuggestions && suggestions.length > 0 && (
            <div class="absolute z-50 w-full mt-1 bg-dark-800 border border-dark-600 rounded-lg shadow-lg overflow-hidden">
              {suggestions.map((tool, index) => (
                <button
                  key={tool.name}
                  type="button"
                  onMouseDown={() => selectSuggestion(tool.name)}
                  class={`w-full px-4 py-2 text-left text-sm transition-colors ${
                    index === selectedIndex ? "bg-neon-purple/20 text-neon-purple" : "text-gray-300 hover:bg-dark-700"
                  }`}
                >
                  <HighlightedName name={tool.name} />
                  {tool.description && (
                    <span class="ml-2 text-xs text-gray-500 truncate">
                      {tool.description.slice(0, 50)}{tool.description.length > 50 ? "..." : ""}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <div class="text-sm text-gray-500 whitespace-nowrap">
          {search.trim() || selectedBackends.size > 0
            ? `${filteredTools.length} of ${tools.length} tools`
            : `${tools.length} tools`}
        </div>
      </div>

      {/* Backend filter chips */}
      {backendCounts.size > 0 && (
        <div class="mb-6 flex items-center gap-2 overflow-x-auto pb-2">
          <span class="text-sm text-gray-500 shrink-0">Filter:</span>
          {[...backendCounts.entries()].map(([backend, count]) => (
            <button
              key={backend}
              onClick={() => toggleBackend(backend)}
              class={`px-3 py-1 text-sm rounded-full border transition-colors shrink-0 ${
                selectedBackends.has(backend)
                  ? "bg-neon-purple/20 border-neon-purple text-neon-purple"
                  : "bg-dark-800 border-dark-600 text-gray-400 hover:border-gray-500 hover:text-gray-300"
              }`}
            >
              {backend}
              <span class="ml-1 text-xs opacity-70">({count})</span>
            </button>
          ))}
          {selectedBackends.size > 0 && (
            <button
              onClick={clearFilters}
              class="px-3 py-1 text-sm rounded-full border border-dark-600 bg-dark-800 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors shrink-0"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3"><SortButton label="Tool" sortKey="name" /></th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">Latest</th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400 hidden lg:table-cell">Backend</th>
              <th class="text-right px-4 py-3 hidden sm:table-cell"><SortButton label="Downloads (30d)" sortKey="downloads" /></th>
              <th class="text-left px-4 py-3 hidden md:table-cell"><SortButton label="Updated" sortKey="updated" /></th>
              <th class="w-10 px-2 py-3 hidden lg:table-cell"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {filteredTools.map((tool) => (
              <tr key={tool.name} class="hover:bg-dark-700 transition-colors">
                <td class="px-4 py-3">
                  <a href={`/tools/${tool.name}`} class="text-neon-purple hover:text-neon-pink font-medium transition-colors">
                    <HighlightedName name={tool.name} />
                  </a>
                </td>
                <td class="px-4 py-3 text-sm font-mono">
                  {tool.github ? (
                    <a
                      href={`https://github.com/${tool.github}/releases/tag/v${tool.latest_stable_version || tool.latest_version}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-neon-blue hover:text-neon-purple transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {tool.latest_stable_version || tool.latest_version}
                    </a>
                  ) : (
                    <span class="text-gray-300">{tool.latest_stable_version || tool.latest_version}</span>
                  )}
                </td>
                <td class="px-4 py-3 text-sm hidden lg:table-cell">
                  {tool.backends && tool.backends[0] && (
                    <span class="px-2 py-0.5 rounded-full text-xs bg-dark-600 text-gray-400">
                      {getBackendType(tool.backends[0])}
                    </span>
                  )}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell text-right">{tool.downloads_30d.toLocaleString()}</td>
                <td class="px-4 py-3 text-sm text-gray-500 hidden md:table-cell">
                  {tool.last_updated ? formatRelativeTime(tool.last_updated) : "-"}
                </td>
                <td class="px-2 py-3 hidden lg:table-cell">
                  {tool.github && (
                    <a
                      href={`https://github.com/${tool.github}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-gray-500 hover:text-gray-300 transition-colors"
                      title={`GitHub: ${tool.github}`}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                      </svg>
                    </a>
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
