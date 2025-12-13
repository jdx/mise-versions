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
    return <div class="text-center py-12 text-gray-500">Loading tools...</div>;
  }

  if (error) {
    return <div class="text-center py-12 text-red-500">Error: {error}</div>;
  }

  return (
    <div>
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-gray-900 mb-2">Recently Updated</h1>
        <p class="text-gray-600">Tools with the most recent version releases</p>
      </div>

      <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700">
                Tool
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700">
                Latest
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700">
                Updated
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700 hidden sm:table-cell">
                Date
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200">
            {recentTools.map((tool) => (
              <tr key={tool.name} class="hover:bg-gray-50">
                <td class="px-4 py-3">
                  <a
                    href={`/${tool.name}`}
                    class="text-blue-600 hover:text-blue-800 font-medium"
                  >
                    {tool.name}
                  </a>
                </td>
                <td class="px-4 py-3 text-sm text-gray-600 font-mono">
                  {tool.latest_version}
                </td>
                <td class="px-4 py-3 text-sm text-gray-600">
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
