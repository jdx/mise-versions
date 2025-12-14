import { useState, useMemo } from "preact/hooks";
import { useTools } from "../hooks/useTools";
import { useAllDownloads } from "../hooks/useAllDownloads";
import { formatRelativeTime } from "../utils/time";

export function HomePage() {
  const { data, loading: toolsLoading, error } = useTools();
  const { data: downloads, loading: downloadsLoading } = useAllDownloads();
  const [search, setSearch] = useState("");

  const loading = toolsLoading || downloadsLoading;

  const filteredTools = useMemo(() => {
    if (!data?.tools) return [];
    const toolsWithDownloads = data.tools.map((t) => ({
      ...t,
      downloads_30d: downloads?.[t.name] || 0,
    }));
    if (!search.trim()) return toolsWithDownloads;
    const query = search.toLowerCase();
    return toolsWithDownloads.filter((t) => t.name.toLowerCase().includes(query));
  }, [data?.tools, downloads, search]);

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
      <div class="mb-6">
        <input
          type="text"
          placeholder="Search tools..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          class="w-full max-w-md px-4 py-2 bg-dark-800 border border-dark-600 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:border-neon-purple focus:ring-1 focus:ring-neon-purple"
        />
      </div>

      <div class="text-sm text-gray-500 mb-4">
        {filteredTools.length} of {data?.tool_count} tools
      </div>

      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">
                Tool
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">
                Latest
              </th>
              <th class="text-right px-4 py-3 text-sm font-medium text-gray-400 hidden sm:table-cell">
                Downloads (30d)
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400 hidden md:table-cell">
                Updated
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
                    {tool.name}
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
