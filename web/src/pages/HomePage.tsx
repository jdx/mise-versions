import { useState, useMemo } from "preact/hooks";
import { useTools } from "../hooks/useTools";
import { formatRelativeTime } from "../utils/time";

export function HomePage() {
  const { data, loading, error } = useTools();
  const [search, setSearch] = useState("");

  const filteredTools = useMemo(() => {
    if (!data?.tools) return [];
    if (!search.trim()) return data.tools;
    const query = search.toLowerCase();
    return data.tools.filter((t) => t.name.toLowerCase().includes(query));
  }, [data?.tools, search]);

  if (loading) {
    return <div class="text-center py-12 text-gray-500">Loading tools...</div>;
  }

  if (error) {
    return <div class="text-center py-12 text-red-500">Error: {error}</div>;
  }

  return (
    <div>
      <div class="mb-6">
        <input
          type="text"
          placeholder="Search tools..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          class="w-full max-w-md px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>

      <div class="text-sm text-gray-500 mb-4">
        {filteredTools.length} of {data?.tool_count} tools
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
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700 hidden sm:table-cell">
                Versions
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700 hidden md:table-cell">
                Updated
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200">
            {filteredTools.map((tool) => (
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
                <td class="px-4 py-3 text-sm text-gray-600 hidden sm:table-cell">
                  {tool.version_count}
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
