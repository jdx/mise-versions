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
      <div class="text-center py-12 text-gray-400">Loading versions...</div>
    );
  }

  if (error) {
    return (
      <div class="text-center py-12">
        <div class="text-red-400 mb-4">Error: {error}</div>
        <a
          href="/"
          class="text-neon-purple hover:text-neon-pink transition-colors"
        >
          Back to tools
        </a>
      </div>
    );
  }

  return (
    <div>
      <div class="mb-6">
        <a
          href="/"
          class="text-neon-purple hover:text-neon-pink text-sm transition-colors"
        >
          &larr; Back to tools
        </a>
      </div>

      <div class="mb-8">
        <h1 class="text-3xl font-bold text-gray-100 mb-2">{tool}</h1>
        <div class="text-gray-400 mb-4">{versions.length} versions</div>

        <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
          <div class="text-sm text-gray-400 mb-1">Install with mise:</div>
          <code class="text-sm font-mono text-neon-blue">
            mise use {tool}@latest
          </code>
        </div>
      </div>

      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">
                Version
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400">
                Released
              </th>
              <th class="text-left px-4 py-3 text-sm font-medium text-gray-400 hidden sm:table-cell">
                Date
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {versions.map((v) => (
              <tr key={v.version} class="hover:bg-dark-700 transition-colors">
                <td class="px-4 py-3 font-mono text-sm text-gray-200">
                  {v.version}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400">
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
