import { useMemo } from "preact/hooks";
import { useTools } from "../hooks/useTools";
import { useAllDownloads } from "../hooks/useAllDownloads";

export function TopPage() {
  const { data: toolsData, loading: toolsLoading, error: toolsError } = useTools();
  const { data: downloads, loading: downloadsLoading } = useAllDownloads();

  const topTools = useMemo(() => {
    if (!toolsData?.tools || !downloads) return [];
    return [...toolsData.tools]
      .map((t) => ({ ...t, downloads_30d: downloads[t.name] || 0 }))
      .sort((a, b) => b.downloads_30d - a.downloads_30d)
      .slice(0, 100);
  }, [toolsData?.tools, downloads]);

  const loading = toolsLoading || downloadsLoading;

  if (loading) {
    return (
      <div class="text-center py-12 text-gray-400">Loading tools...</div>
    );
  }

  if (toolsError) {
    return <div class="text-center py-12 text-red-400">Error: {toolsError}</div>;
  }

  return (
    <div>
      <div class="mb-6">
        <h1 class="text-2xl font-bold text-gray-100 mb-2">Top Downloads</h1>
        <p class="text-gray-400">Most downloaded tools in the last 30 days</p>
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
              <th class="text-right px-4 py-3 text-sm font-medium text-gray-400">
                Downloads (30d)
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {topTools.map((tool) => (
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
                <td class="px-4 py-3 text-sm text-gray-400 text-right">
                  {tool.downloads_30d.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
