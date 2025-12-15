import { useState, useMemo } from "preact/hooks";
import { useToolVersions } from "../hooks/useToolVersions";
import { useDownloads } from "../hooks/useDownloads";
import { useTools, Tool } from "../hooks/useTools";
import { useGithubRepo, parseGithubSlug } from "../hooks/useGithubRepo";
import { useAuth } from "../hooks/useAuth";
import { formatRelativeTime, formatDate } from "../utils/time";

interface Props {
  params: { tool: string };
}

type VersionSortKey = "default" | "downloads" | "released";

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

const packageUrlLabels: Record<string, string> = {
  npm: "npm",
  cargo: "crates.io",
  pypi: "PyPI",
  rubygems: "RubyGems",
  go: "pkg.go.dev",
};

// Convert a backend string like "npm:foo" or "aqua:owner/repo" to a URL
function backendToUrl(backend: string): string | null {
  const match = backend.match(/^(?<prefix>.+?):(?<slug>.+?)(?:\[.+\])?$/);
  if (!match?.groups) return null;

  const { prefix, slug } = match.groups;

  switch (prefix) {
    case "npm":
      return `https://www.npmjs.com/package/${slug}`;
    case "cargo":
      return `https://crates.io/crates/${slug}`;
    case "pipx":
      return `https://pypi.org/project/${slug}`;
    case "gem":
      return `https://rubygems.org/gems/${slug}`;
    case "go":
      return `https://pkg.go.dev/${slug}`;
    case "aqua":
    case "github":
    case "ubi":
    case "asdf":
    case "vfox": {
      // Extract owner/repo from slug
      const parts = slug.split("/").slice(0, 2).join("/");
      return `https://github.com/${parts}`;
    }
    case "core":
      return `https://mise.jdx.dev/lang/${slug}.html`;
    case "dotnet":
      return `https://www.nuget.org/packages/${slug}`;
    case "gitlab":
      return `https://gitlab.com/${slug}`;
    default:
      return null;
  }
}

// Info pane: install command, metadata, links, GitHub stats
function InfoPane({ tool, toolMeta }: { tool: string; toolMeta: Tool | undefined }) {
  const { authenticated } = useAuth();
  const parsed = toolMeta?.github ? parseGithubSlug(toolMeta.github) : null;
  const { data: ghData } = useGithubRepo(
    parsed?.owner ?? null,
    parsed?.repo ?? null
  );

  const hasMetadata = toolMeta && (toolMeta.license || toolMeta.homepage || toolMeta.repo_url || toolMeta.authors?.length);
  const hasLinks = toolMeta && (toolMeta.package_urls || toolMeta.aqua_link || toolMeta.backends?.length);
  const hasGithub = authenticated && ghData && (ghData.stars > 0 || (ghData.topics && ghData.topics.length > 0));

  return (
    <div class="space-y-4">
      {/* Install command */}
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
        <div class="text-sm text-gray-400 mb-1">Install with mise:</div>
        <code class="text-sm font-mono text-neon-blue">
          mise use {tool}@latest
        </code>
      </div>

      {/* Combined info pane */}
      {(hasMetadata || hasLinks || hasGithub) && (
        <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 space-y-4">
          {/* Metadata */}
          {hasMetadata && (
            <dl class="space-y-2 text-sm">
              {toolMeta.license && (
                <div class="flex">
                  <dt class="text-gray-500 w-24 flex-shrink-0">License</dt>
                  <dd class="text-gray-300">{toolMeta.license}</dd>
                </div>
              )}
              {toolMeta.homepage && (() => {
                try {
                  const url = new URL(toolMeta.homepage);
                  return (
                    <div class="flex">
                      <dt class="text-gray-500 w-24 flex-shrink-0">Homepage</dt>
                      <dd>
                        <a
                          href={toolMeta.homepage}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-neon-blue hover:text-neon-purple transition-colors"
                        >
                          {url.hostname}
                        </a>
                      </dd>
                    </div>
                  );
                } catch {
                  return null;
                }
              })()}
              {toolMeta.repo_url && (
                <div class="flex">
                  <dt class="text-gray-500 w-24 flex-shrink-0">Repository</dt>
                  <dd>
                    <a
                      href={toolMeta.repo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-neon-blue hover:text-neon-purple transition-colors"
                    >
                      {toolMeta.github}
                    </a>
                  </dd>
                </div>
              )}
              {toolMeta.authors && toolMeta.authors.length > 0 && (
                <div class="flex">
                  <dt class="text-gray-500 w-24 flex-shrink-0">Authors</dt>
                  <dd class="text-gray-300">
                    {toolMeta.authors.slice(0, 3).join(", ")}
                    {toolMeta.authors.length > 3 && ` +${toolMeta.authors.length - 3} more`}
                  </dd>
                </div>
              )}
            </dl>
          )}

          {/* Divider if we have both metadata and links */}
          {hasMetadata && (hasLinks || hasGithub) && (
            <div class="border-t border-dark-600" />
          )}

          {/* Links */}
          {hasLinks && (
            <div class="space-y-3">
              {/* Package manager links */}
              {(toolMeta.package_urls || toolMeta.aqua_link) && (
                <div class="flex flex-wrap gap-2">
                  {toolMeta.package_urls &&
                    Object.entries(toolMeta.package_urls).map(([key, url]) => (
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
                  {toolMeta.aqua_link && (
                    <a
                      href={toolMeta.aqua_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="px-3 py-1.5 bg-dark-700 hover:bg-dark-600 rounded text-sm text-neon-blue hover:text-neon-purple transition-colors"
                    >
                      aqua registry
                    </a>
                  )}
                </div>
              )}

              {/* Backends */}
              {toolMeta.backends && toolMeta.backends.length > 0 && (
                <div>
                  <div class="text-xs text-gray-500 mb-1">Backends</div>
                  <div class="flex flex-wrap gap-1">
                    {toolMeta.backends.map((backend) => (
                      <span
                        key={backend}
                        class="px-2 py-0.5 bg-dark-700 rounded text-xs font-mono text-gray-400"
                      >
                        {backend}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Divider before GitHub stats */}
          {(hasMetadata || hasLinks) && hasGithub && (
            <div class="border-t border-dark-600" />
          )}

          {/* GitHub stats (auth-gated) */}
          {hasGithub && (
            <div class="space-y-2">
              <div class="flex flex-wrap gap-3 text-sm">
                {ghData.stars > 0 && (
                  <span class="text-gray-400">
                    <span class="text-yellow-400">★</span> {ghData.stars.toLocaleString()} stars
                  </span>
                )}
              </div>
              {ghData.topics && ghData.topics.length > 0 && (
                <div class="flex flex-wrap gap-1">
                  {ghData.topics.slice(0, 8).map((topic) => (
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
          )}
        </div>
      )}
    </div>
  );
}

// Downloads pane: chart, top versions, by platform
function DownloadsPane({
  data,
  loading,
}: {
  data: { daily: Array<{ date: string; count: number }>; byVersion: Array<{ version: string; count: number }>; byOs: Array<{ os: string | null; count: number }> } | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
        <h2 class="text-lg font-semibold text-gray-200 mb-3">Downloads</h2>
        <div class="mb-4">
          <div class="text-sm text-gray-400 mb-2">Last 30 days</div>
          <div class="h-32 flex items-end gap-0.5">
            {[...Array(30)].map((_, i) => (
              <div key={i} class="flex-1">
                <div
                  class="bg-dark-600 rounded-t animate-pulse"
                  style={{ height: `${20 + Math.random() * 60}%` }}
                />
              </div>
            ))}
          </div>
        </div>
        <div class="mt-4 pt-4 border-t border-dark-600">
          <div class="text-sm text-gray-400 mb-2">Top versions</div>
          <div class="space-y-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} class="flex justify-between">
                <div class="h-4 w-16 bg-dark-600 rounded animate-pulse" />
                <div class="h-4 w-10 bg-dark-600 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
      <h2 class="text-lg font-semibold text-gray-200 mb-3">Downloads</h2>

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
  const [sortBy, setSortBy] = useState<VersionSortKey>("default");

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

  // Sort versions based on selected sort key
  const sortedVersions = useMemo(() => {
    if (!versions) return [];
    if (sortBy === "default") return versions;

    return [...versions].sort((a, b) => {
      switch (sortBy) {
        case "downloads":
          return (versionDownloads.get(b.version) || 0) - (versionDownloads.get(a.version) || 0);
        case "released":
          if (!a.created_at && !b.created_at) return 0;
          if (!a.created_at) return 1;
          if (!b.created_at) return -1;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        default:
          return 0;
      }
    });
  }, [versions, sortBy, versionDownloads]);

  const SortButton = ({ label, sortKey }: { label: string; sortKey: VersionSortKey }) => (
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

  if (error) {
    return (
      <div class="text-center py-12">
        <div class="text-red-400">Error: {error}</div>
      </div>
    );
  }

  // Skeleton row for version table
  const SkeletonVersionRow = () => (
    <tr>
      <td class="px-4 py-3">
        <div class="h-5 w-20 bg-dark-600 rounded animate-pulse" />
      </td>
      <td class="px-4 py-3 hidden sm:table-cell text-right">
        <div class="h-5 w-12 bg-dark-600 rounded animate-pulse ml-auto" />
      </td>
      <td class="px-4 py-3 text-right">
        <div class="h-5 w-32 bg-dark-600 rounded animate-pulse ml-auto" />
      </td>
    </tr>
  );

  return (
    <div>
      {/* Header */}
      <div class="mb-6">
        <h1 class="text-3xl font-bold text-gray-100 mb-2">{tool}</h1>
        {toolMeta?.description && (
          <p class="text-gray-400 mb-2">{toolMeta.description}</p>
        )}
        <div class="text-sm text-gray-500 flex flex-wrap items-center gap-x-1">
          {toolMeta?.backends?.[0] && (() => {
            const backend = toolMeta.backends[0];
            const url = backendToUrl(backend);
            return url ? (
              <>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="font-mono text-neon-blue hover:text-neon-purple transition-colors"
                >
                  {backend.replace(/\[.*\]$/, "")}
                </a>
                <span>·</span>
              </>
            ) : (
              <>
                <span class="font-mono">{backend.replace(/\[.*\]$/, "")}</span>
                <span>·</span>
              </>
            );
          })()}
          {loading ? (
            <div class="h-4 w-20 bg-dark-600 rounded animate-pulse inline-block" />
          ) : (
            <span>{versions.length} versions</span>
          )}
          {downloadData && (
            <>
              <span>·</span>
              <span>{downloadData.total.toLocaleString()} downloads</span>
            </>
          )}
        </div>
      </div>

      {/* Two-column layout */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
        {/* Left column: Info */}
        <InfoPane tool={tool} toolMeta={toolMeta} />

        {/* Right column: Downloads */}
        <DownloadsPane data={downloadData} loading={downloadsLoading} />
      </div>

      {/* Version table */}
      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3">
                <SortButton label="Version" sortKey="default" />
              </th>
              <th class="text-right px-4 py-3 hidden sm:table-cell">
                <SortButton label="Downloads" sortKey="downloads" />
              </th>
              <th class="text-right px-4 py-3">
                <SortButton label="Released" sortKey="released" />
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-dark-600">
            {loading ? (
              <>
                {[...Array(15)].map((_, i) => <SkeletonVersionRow key={i} />)}
              </>
            ) : (
              sortedVersions.map((v) => (
                <tr key={v.version} class="hover:bg-dark-700 transition-colors">
                  <td class="px-4 py-3 font-mono text-sm text-gray-200">
                    {v.version}
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-400 hidden sm:table-cell text-right">
                    {downloadsLoading ? (
                      <div class="h-4 w-10 bg-dark-600 rounded animate-pulse ml-auto" />
                    ) : (
                      (versionDownloads.get(v.version) || 0).toLocaleString()
                    )}
                  </td>
                  <td class="px-4 py-3 text-sm text-gray-400 text-right">
                    {v.created_at ? (
                      <>
                        {formatRelativeTime(v.created_at)}{" "}
                        <span class="text-gray-500">({formatDate(v.created_at)})</span>
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
