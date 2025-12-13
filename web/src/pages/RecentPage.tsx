import { useMemo } from "preact/hooks";
import { useTools } from "../hooks/useTools";
import { formatRelativeTime, formatDate } from "../utils/time";

export function RecentPage() {
  const { data, loading, error } = useTools();

  const recentTools = useMemo(() => {
    if (!data?.tools) return [];
    return [...data.tools]
      .filter((t) => t.last_updated)
      .sort((a, b) => {
        if (!a.last_updated || !b.last_updated) return 0;
        return (
          new Date(b.last_updated).getTime() -
          new Date(a.last_updated).getTime()
        );
      })
      .slice(0, 100);
  }, [data?.tools]);

  if (loading) {
    return (
      <div class="text-center py-12 text-gray-400">Loading tools...</div>
    );
  }

  if (error) {
    return <div class="text-center py-12 text-red-400">Error: {error}</div>;
  }

  return (
    <div>
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-gray-100 mb-2">Recently Updated</h1>
        <p class="text-gray-400">Tools with the most recent version releases</p>
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
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">
                Updated
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400 hidden sm:table-cell">
                Date
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {recentTools.map((tool) => (
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
                <td class="px-4 py-3 text-sm text-gray-400">
                  {tool.last_updated
                    ? formatRelativeTime(tool.last_updated)
                    : "-"}
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 hidden sm:table-cell">
                  {tool.last_updated ? formatDate(tool.last_updated) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
