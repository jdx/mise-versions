import { useToolVersions } from "../hooks/useToolVersions";
import { formatRelativeTime, formatDate } from "../utils/time";

interface Props {
  params: { tool: string };
}

export function ToolPage({ params }: Props) {
  const { tool } = params;
  const { versions, loading, error } = useToolVersions(tool);

  if (loading) {
    return (
      <div class="text-center py-12 text-gray-500">Loading versions...</div>
    );
  }

  if (error) {
    return (
      <div class="text-center py-12">
        <div class="text-red-500 mb-4">Error: {error}</div>
        <a href="/" class="text-blue-600 hover:text-blue-800">
          Back to tools
        </a>
      </div>
    );
  }

  return (
    <div>
      <div class="mb-6">
        <a href="/" class="text-blue-600 hover:text-blue-800 text-sm">
          &larr; Back to tools
        </a>
      </div>

      <div class="mb-8">
        <h1 class="text-3xl font-bold text-gray-900 mb-2">{tool}</h1>
        <div class="text-gray-600 mb-4">{versions.length} versions</div>

        <div class="bg-gray-100 rounded-lg p-4">
          <div class="text-sm text-gray-600 mb-1">Install with mise:</div>
          <code class="text-sm font-mono text-gray-900">
            mise use {tool}@latest
          </code>
        </div>
      </div>

      <div class="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table class="w-full">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700">
                Version
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700">
                Released
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-700 hidden sm:table-cell">
                Date
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-200">
            {versions.map((v) => (
              <tr key={v.version} class="hover:bg-gray-50">
                <td class="px-4 py-3 font-mono text-sm">{v.version}</td>
                <td class="px-4 py-3 text-sm text-gray-600">
                  {v.created_at ? formatRelativeTime(v.created_at) : "-"}
                </td>
                <td class="px-4 py-3 text-sm text-gray-500 hidden sm:table-cell">
                  {v.created_at ? formatDate(v.created_at) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
