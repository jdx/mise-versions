import { useState, useMemo } from "preact/hooks";
import { useTools } from "../hooks/useTools";
import { useAllDownloads } from "../hooks/useAllDownloads";
import { formatRelativeTime } from "../utils/time";

type SortKey = "name" | "downloads" | "updated";

export function HomePage() {
  const { data, loading: toolsLoading, error } = useTools();
  const { data: downloads, loading: downloadsLoading } = useAllDownloads();
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("downloads");

  const loading = toolsLoading || downloadsLoading;

  const filteredTools = useMemo(() => {
    if (!data?.tools) return [];
    let toolsWithDownloads = data.tools.map((t) => ({
      ...t,
      downloads_30d: downloads?.[t.name] || 0,
    }));

    // Filter by search
    if (search.trim()) {
      const query = search.toLowerCase();
      toolsWithDownloads = toolsWithDownloads.filter((t) =>
        t.name.toLowerCase().includes(query)
      );
    }

    // Sort
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
  }, [data?.tools, downloads, search, sortBy]);

  const SortButton = ({ label, sortKey }: { label: string; sortKey: SortKey }) => (
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

  const HighlightedName = ({ name }: { name: string }) => {
    const query = search.trim().toLowerCase();
    if (!query) return <>{name}</>;

    const index = name.toLowerCase().indexOf(query);
    if (index === -1) return <>{name}</>;

    const before = name.slice(0, index);
    const match = name.slice(index, index + query.length);
    const after = name.slice(index + query.length);

    return (
      <>
        {before}
        <span class="bg-neon-purple/30 rounded px-0.5">{match}</span>
        {after}
      </>
    );
  };

  if (loading) {
    return (
      <div class="text-center py-12 text-gray-400">Loading tools...</div>
    );
  }

  if (error) {
    return (
      <div class="text-center py-12 text-red-400">Error: {error}</div>
    );
  }

  return (
    <div>
      <div class="mb-6 flex items-center justify-between gap-4">
        <input
          type="text"
          placeholder="Search tools..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          class="w-full max-w-md px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-neon-purple focus:ring-1 focus:ring-neon-purple"
        />
        <div class="text-sm text-gray-500 whitespace-nowrap">
          {search.trim()
            ? `${filteredTools.length} of ${data?.tool_count} tools`
            : `${data?.tool_count} tools`}
        </div>
      </div>

      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3">
                <SortButton label="Tool" sortKey="name" />
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">
                Latest
              </th>
              <th class="text-right px-4 py-3 hidden sm:table-cell">
                <SortButton label="Downloads (30d)" sortKey="downloads" />
              </th>
              <th class="text-left px-4 py-3 hidden md:table-cell">
                <SortButton label="Updated" sortKey="updated" />
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {filteredTools.map((tool) => (
              <tr key={tool.name} class="hover:bg-dark-700 transition-colors">
                <td class="px-4 py-3">
                  <a
                    href={`/${tool.name}`}
                    class="text-neon-purple hover:text-neon-pink font-medium transition-colors"
                  >
                    <HighlightedName name={tool.name} />
                  </a>
                </td>
                <td class="px-4 py-3 text-sm text-gray-300 font-mono">
                  {tool.latest_version}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell text-right">
                  {tool.downloads_30d.toLocaleString()}
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 hidden md:table-cell">
                  {tool.last_updated
                    ? formatRelativeTime(tool.last_updated)
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
