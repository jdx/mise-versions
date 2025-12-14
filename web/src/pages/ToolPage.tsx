import { useToolVersions } from "../hooks/useToolVersions";
import { useDownloads } from "../hooks/useDownloads";
import { useTools, Tool } from "../hooks/useTools";
import { useGithubRepo, parseGithubSlug } from "../hooks/useGithubRepo";
import { useAuth } from "../hooks/useAuth";
import { formatRelativeTime, formatDate } from "../utils/time";

interface Props {
  params: { tool: string };
}

function DownloadChart({
  daily,
}: {
  daily: Array<{ date: string; count: number }>;
}) {
  if (!daily || daily.length === 0) {
    return (
      <div class="text-gray-500 text-sm py-4">No download data yet</div>
    );
  }

  const maxCount = Math.max(...daily.map((d) => d.count), 1);

  // Fill in missing days for the last 30 days
  const today = new Date();
  const days: Array<{ date: string; count: number }> = [];
  const dailyMap = new Map(daily.map((d) => [d.date, d.count]));

  for (let i = 29; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    days.push({ date: dateStr, count: dailyMap.get(dateStr) || 0 });
  }

  return (
    <div class="h-32 flex items-end gap-0.5">
      {days.map((d) => {
        const height = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
        const dateObj = new Date(d.date);
        const label = dateObj.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });
        return (
          <div
            key={d.date}
            class="flex-1 group relative"
            title={`${label}: ${d.count} downloads`}
          >
            <div
              class="bg-neon-purple hover:bg-neon-pink transition-colors rounded-t"
              style={{ height: `${Math.max(height, 2)}%` }}
            />
            <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-dark-700 rounded text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
              {label}: {d.count}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Metadata section showing license, homepage, authors, repo link (public for all users)
function MetadataSection({ tool }: { tool: Tool }) {
  const hasMetadata = tool.license || tool.homepage || tool.authors?.length || tool.repo_url;
  if (!hasMetadata) return null;

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-8">
      <h2 class="text-lg font-semibold text-gray-200 mb-3">About</h2>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
        {tool.license && (
          <div>
            <span class="text-gray-500">License:</span>
            <span class="text-gray-300 ml-2">{tool.license}</span>
          </div>
        )}

        {tool.homepage && (() => {
          try {
            const url = new URL(tool.homepage);
            return (
              <div>
                <span class="text-gray-500">Homepage:</span>
                <a
                  href={tool.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-neon-blue hover:text-neon-purple transition-colors ml-2"
                >
                  {url.hostname}
                </a>
              </div>
            );
          } catch {
            return null;
          }
        })()}

        {tool.repo_url && (
          <div>
            <span class="text-gray-500">Repository:</span>
            <a
              href={tool.repo_url}
              target="_blank"
              rel="noopener noreferrer"
              class="text-neon-blue hover:text-neon-purple transition-colors ml-2"
            >
              {tool.github}
            </a>
          </div>
        )}

        {tool.authors && tool.authors.length > 0 && (
          <div class="sm:col-span-2">
            <span class="text-gray-500">Authors:</span>
            <span class="text-gray-300 ml-2">{tool.authors.join(", ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// Backend links section showing backends and package manager links (public for all users)
function BackendLinks({ tool }: { tool: Tool }) {
  const hasLinks = tool.backends?.length || tool.aqua_link || tool.package_urls;
  if (!hasLinks) return null;

  const packageUrlLabels: Record<string, string> = {
    npm: "npm",
    cargo: "crates.io",
    pypi: "PyPI",
    rubygems: "RubyGems",
    go: "pkg.go.dev",
  };

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-8">
      <h2 class="text-lg font-semibold text-gray-200 mb-3">Installation Sources</h2>

      {tool.backends && tool.backends.length > 0 && (
        <div class="mb-3">
          <div class="text-sm text-gray-500 mb-2">Backends</div>
          <div class="flex flex-wrap gap-1">
            {tool.backends.map((backend) => (
              <span
                key={backend}
                class="px-2 py-1 bg-dark-700 rounded text-xs font-mono text-gray-400"
              >
                {backend}
              </span>
            ))}
          </div>
        </div>
      )}

      <div class="flex flex-wrap gap-2">
        {tool.package_urls &&
          Object.entries(tool.package_urls).map(([key, url]) => (
            <a
              key={key}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              class="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm text-neon-blue hover:text-neon-purple transition-colors"
            >
              {packageUrlLabels[key] || key}
            </a>
          ))}

        {tool.aqua_link && (
          <a
            href={tool.aqua_link}
            target="_blank"
            rel="noopener noreferrer"
            class="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm text-neon-blue hover:text-neon-purple transition-colors"
          >
            aqua registry
          </a>
        )}
      </div>
    </div>
  );
}

// GitHub dynamic info (stars, topics) - only for authenticated users
function GithubInfo({ github }: { github: string | undefined }) {
  const { authenticated } = useAuth();
  const parsed = github ? parseGithubSlug(github) : null;
  const { data, loading, error } = useGithubRepo(
    parsed?.owner ?? null,
    parsed?.repo ?? null
  );

  // Don't show if no GitHub slug
  if (!parsed) return null;

  // Don't show if not authenticated
  if (!authenticated) return null;

  if (loading) {
    return (
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-8">
        <div class="text-gray-500 animate-pulse">Loading GitHub stats...</div>
      </div>
    );
  }

  if (error || !data) return null;

  // Only show if we have stars or topics (the dynamic data)
  const hasData = data.stars > 0 || (data.topics && data.topics.length > 0);
  if (!hasData) return null;

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-8">
      <h2 class="text-lg font-semibold text-gray-200 mb-3">GitHub Stats</h2>

      <div class="flex flex-wrap gap-3 text-sm">
        {data.stars > 0 && (
          <span class="text-gray-400">
            <span class="text-yellow-400">&#9733;</span> {data.stars.toLocaleString()} stars
          </span>
        )}
      </div>

      {data.topics && data.topics.length > 0 && (
        <div class="mt-3 flex flex-wrap gap-1">
          {data.topics.slice(0, 8).map((topic) => (
            <span
              key={topic}
              class="px-2 py-0.5 bg-dark-700 rounded text-xs text-gray-400"
            >
              {topic}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadStats({ tool }: { tool: string }) {
  const { data, loading, error } = useDownloads(tool);

  if (loading) {
    return (
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-8">
        <div class="text-gray-500 animate-pulse">Loading download stats...</div>
      </div>
    );
  }

  if (error || !data) {
    return null; // Silently hide if no stats available
  }

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-8">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-semibold text-gray-200">Downloads</h2>
        <div class="text-2xl font-bold text-neon-purple">
          {data.total.toLocaleString()}
        </div>
      </div>

      <div class="mb-4">
        <div class="text-sm text-gray-400 mb-2">Last 30 days</div>
        <DownloadChart daily={data.daily} />
      </div>

      {data.byVersion.length > 0 && (
        <div class="mt-4 pt-4 border-t border-dark-600">
          <div class="text-sm text-gray-400 mb-2">Top versions</div>
          <div class="space-y-1">
            {data.byVersion.slice(0, 5).map((v) => (
              <div key={v.version} class="flex justify-between text-sm">
                <span class="font-mono text-gray-300">{v.version}</span>
                <span class="text-gray-500">{v.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.byOs.length > 0 && (
        <div class="mt-4 pt-4 border-t border-dark-600">
          <div class="text-sm text-gray-400 mb-2">By platform</div>
          <div class="flex flex-wrap gap-2">
            {data.byOs
              .filter((o) => o.os)
              .map((o) => (
                <span
                  key={o.os}
                  class="px-2 py-1 bg-dark-700 rounded text-xs text-gray-300"
                >
                  {o.os}: {o.count.toLocaleString()}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ToolPage({ params }: Props) {
  const { tool } = params;
  const { versions, loading: versionsLoading, error } = useToolVersions(tool);
  const { data: downloadData, loading: downloadsLoading } = useDownloads(tool);
  const { data: toolsData } = useTools();

  // Find tool metadata from tools.json
  const toolMeta = toolsData?.tools.find((t) => t.name === tool);

  const loading = versionsLoading;

  // Create a map of version -> download count
  const versionDownloads = new Map<string, number>();
  if (downloadData?.byVersion) {
    for (const v of downloadData.byVersion) {
      versionDownloads.set(v.version, v.count);
    }
  }

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
        {toolMeta?.description && (
          <p class="text-gray-400 mb-3">{toolMeta.description}</p>
        )}
        <div class="text-gray-500 mb-4">{versions.length} versions</div>

        <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
          <div class="text-sm text-gray-400 mb-1">Install with mise:</div>
          <code class="text-sm font-mono text-neon-blue">
            mise use {tool}@latest
          </code>
        </div>
      </div>

      {toolMeta && <MetadataSection tool={toolMeta} />}

      {toolMeta && <BackendLinks tool={toolMeta} />}

      <GithubInfo github={toolMeta?.github} />

      <DownloadStats tool={tool} />

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
              <th class="text-right px-4 py-3 text-sm font-medium text-gray-400 hidden sm:table-cell">
                Downloads
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
                  {v.created_at ? (
                    <>
                      {formatRelativeTime(v.created_at)}{" "}
                      <span class="text-gray-500">({formatDate(v.created_at)})</span>
                    </>
                  ) : (
                    "-"
                  )}
                </td>
                <td class="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell text-right">
                  {downloadsLoading ? (
                    <span class="text-gray-600">...</span>
                  ) : (
                    (versionDownloads.get(v.version) || 0).toLocaleString()
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
