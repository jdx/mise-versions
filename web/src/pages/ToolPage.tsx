import { useState, useMemo, useEffect } from "preact/hooks";
import { useToolVersions } from "../hooks/useToolVersions";
import { useDownloads } from "../hooks/useDownloads";
import { useTools, Tool, SecurityFeature } from "../hooks/useTools";
import { useGithubRepo, parseGithubSlug } from "../hooks/useGithubRepo";
import { useAuth } from "../hooks/useAuth";
import { formatRelativeTime, formatDate } from "../utils/time";

interface Props {
  params: { tool: string };
}

type VersionSortKey = "default" | "downloads" | "released";

interface Version {
  version: string;
  created_at?: string | null;
}

function getInterestingPrefixes(versions: Version[]): string[] {
  if (!versions || versions.length === 0) return [];

  // Parse versions and group by major
  const majorGroups = new Map<string, string[]>();
  const minorGroups = new Map<string, string[]>();

  for (const v of versions) {
    const parts = v.version.split(".");
    if (parts.length >= 1) {
      const major = parts[0];
      if (!majorGroups.has(major)) {
        majorGroups.set(major, []);
      }
      majorGroups.get(major)!.push(v.version);

      if (parts.length >= 2) {
        const minor = `${parts[0]}.${parts[1]}`;
        if (!minorGroups.has(minor)) {
          minorGroups.set(minor, []);
        }
        minorGroups.get(minor)!.push(v.version);
      }
    }
  }

  // Decide granularity: use major if 4+, otherwise minor
  const useMajor = majorGroups.size >= 4;
  const groups = useMajor ? majorGroups : minorGroups;

  // Sort by version number descending (newest first)
  const sortedPrefixes = Array.from(groups.keys()).sort((a, b) => {
    const aParts = a.split(".").map(Number);
    const bParts = b.split(".").map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aVal = aParts[i] || 0;
      const bVal = bParts[i] || 0;
      if (bVal !== aVal) return bVal - aVal;
    }
    return 0;
  });

  // Limit to 8 pills max
  return sortedPrefixes.slice(0, 8);
}

type ChartView = "30d" | "12m";

function DailyBarChart({
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
            class="flex-1 h-full flex items-end group relative"
            title={`${label}: ${d.count} downloads`}
          >
            <div
              class="w-full bg-neon-purple hover:bg-neon-pink transition-colors rounded-t"
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

function MonthlyLineChart({
  monthly,
}: {
  monthly: Array<{ month: string; count: number }>;
}) {
  if (!monthly || monthly.length === 0) {
    return (
      <div class="text-gray-500 text-sm py-4">No download data yet</div>
    );
  }

  // Fill in missing months for the last 12 months
  const today = new Date();
  const months: Array<{ month: string; count: number }> = [];
  const monthlyMap = new Map(monthly.map((m) => [m.month, m.count]));

  for (let i = 11; i >= 0; i--) {
    const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const monthStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    months.push({ month: monthStr, count: monthlyMap.get(monthStr) || 0 });
  }

  const maxCount = Math.max(...months.map((m) => m.count), 1);
  const chartHeight = 128;

  // Create SVG path for the line
  const points = months.map((m, i) => {
    const x = (i / (months.length - 1)) * 100;
    const y = chartHeight - (m.count / maxCount) * (chartHeight - 20);
    return { x, y, ...m };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  // Create area path (line + bottom edge)
  const areaPath = `${linePath} L 100 ${chartHeight} L 0 ${chartHeight} Z`;

  return (
    <div class="h-32 relative">
      <svg
        viewBox={`0 0 100 ${chartHeight}`}
        preserveAspectRatio="none"
        class="w-full h-full"
      >
        {/* Gradient fill under the line */}
        <defs>
          <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#B026FF" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#B026FF" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#areaGradient)" />
        <path
          d={linePath}
          fill="none"
          stroke="#B026FF"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {/* Data points */}
        {points.map((p) => (
          <circle
            key={p.month}
            cx={p.x}
            cy={p.y}
            r="3"
            fill="#B026FF"
            class="hover:fill-[#FF2D95] cursor-pointer"
            vectorEffect="non-scaling-stroke"
          >
            <title>
              {new Date(p.month + "-01").toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
              })}
              : {p.count.toLocaleString()}
            </title>
          </circle>
        ))}
      </svg>
      {/* X-axis labels */}
      <div class="flex justify-between text-xs text-gray-500 mt-1">
        {months.filter((_, i) => i % 3 === 0 || i === months.length - 1).map((m) => (
          <span key={m.month}>
            {new Date(m.month + "-01").toLocaleDateString("en-US", {
              month: "short",
            })}
          </span>
        ))}
      </div>
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

// Format security feature for display
function formatSecurityFeature(feature: SecurityFeature): { label: string; color: string } {
  switch (feature.type) {
    case "checksum":
      return {
        label: feature.algorithm ? `checksum (${feature.algorithm})` : "checksum",
        color: "text-green-400",
      };
    case "github_attestations":
      return { label: "GitHub attestations", color: "text-green-400" };
    case "slsa":
      return { label: "SLSA", color: "text-green-400" };
    case "cosign":
      return { label: "cosign", color: "text-green-400" };
    case "minisign":
      return { label: "minisign", color: "text-green-400" };
    case "gpg":
      return { label: "GPG", color: "text-green-400" };
    default:
      return { label: feature.type, color: "text-gray-400" };
  }
}

// Version Timeline Component
function VersionTimeline({ versions }: { versions: Version[] }) {
  // Filter to only versions with dates and sort chronologically
  const datedVersions = versions
    .filter((v) => v.created_at)
    .sort((a, b) => new Date(a.created_at!).getTime() - new Date(b.created_at!).getTime());

  if (datedVersions.length < 2) return null;

  // Get major and minor versions for milestones
  const milestones: Array<{ version: string; date: Date; isMajor: boolean }> = [];
  const seenMinors = new Set<string>();

  for (const v of datedVersions) {
    const parts = v.version.split(".");
    if (parts.length >= 2) {
      const minor = `${parts[0]}.${parts[1]}`;
      if (!seenMinors.has(minor)) {
        seenMinors.add(minor);
        const isMajor = parts[1] === "0" || parts[1] === ""; // x.0 is a major release
        milestones.push({
          version: v.version,
          date: new Date(v.created_at!),
          isMajor,
        });
      }
    }
  }

  // Add latest version if not already a milestone
  const latest = datedVersions[datedVersions.length - 1];
  if (!milestones.some((m) => m.version === latest.version)) {
    milestones.push({
      version: latest.version,
      date: new Date(latest.created_at!),
      isMajor: false,
    });
  }

  // Limit to 10 milestones for readability
  const displayMilestones = milestones.slice(-10);

  if (displayMilestones.length < 2) return null;

  const firstDate = displayMilestones[0].date.getTime();
  const lastDate = displayMilestones[displayMilestones.length - 1].date.getTime();
  const range = lastDate - firstDate || 1;

  // Calculate release stats
  const totalDays = (lastDate - firstDate) / (1000 * 60 * 60 * 24);
  const avgDaysBetween = totalDays / (datedVersions.length - 1);

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4 mb-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-medium text-gray-300">Release Timeline</h3>
        <div class="text-xs text-gray-500">
          {datedVersions.length} releases over{" "}
          {Math.round(totalDays / 365) > 0
            ? `${Math.round(totalDays / 365)}y`
            : `${Math.round(totalDays)}d`}
          {avgDaysBetween > 0 && (
            <span class="ml-2">
              (~{avgDaysBetween < 30 ? `${Math.round(avgDaysBetween)}d` : `${Math.round(avgDaysBetween / 30)}mo`} avg)
            </span>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div class="relative h-16">
        {/* Line */}
        <div class="absolute top-6 left-0 right-0 h-0.5 bg-dark-600" />

        {/* Milestones */}
        {displayMilestones.map((m) => {
          const position = ((m.date.getTime() - firstDate) / range) * 100;
          return (
            <div
              key={m.version}
              class="absolute -translate-x-1/2 group"
              style={{ left: `${Math.min(Math.max(position, 2), 98)}%` }}
            >
              {/* Dot */}
              <div
                class={`w-3 h-3 rounded-full mt-5 ${
                  m.isMajor ? "bg-neon-purple" : "bg-neon-blue"
                } hover:ring-2 hover:ring-neon-purple/50 transition-all cursor-pointer`}
              />
              {/* Label */}
              <div class="absolute top-8 left-1/2 -translate-x-1/2 text-xs whitespace-nowrap">
                <span class={`font-mono ${m.isMajor ? "text-gray-300" : "text-gray-500"}`}>
                  {m.version.split(".").slice(0, m.isMajor ? 1 : 2).join(".")}
                </span>
              </div>
              {/* Tooltip */}
              <div class="absolute bottom-8 left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-dark-700 rounded text-xs text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10 border border-dark-600">
                <div class="font-mono text-neon-purple">{m.version}</div>
                <div class="text-gray-500">
                  {m.date.toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

  const hasMetadata = toolMeta && (toolMeta.license || toolMeta.homepage || toolMeta.repo_url || toolMeta.authors?.length || toolMeta.security?.length);
  const hasLinks = toolMeta && (toolMeta.package_urls || toolMeta.aqua_link || toolMeta.backends?.length);
  const hasGithub = authenticated && ghData && (ghData.stars > 0 || (ghData.topics && ghData.topics.length > 0));
  const showGithubPlaceholder = !authenticated && parsed !== null; // Tool has GitHub but user not logged in

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
      {(hasMetadata || hasLinks || hasGithub || showGithubPlaceholder) && (
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
                      class="text-neon-blue hover:text-neon-purple transition-colors inline-flex items-center gap-1"
                    >
                      <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                      </svg>
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
              {toolMeta.security && toolMeta.security.length > 0 && (
                <div class="flex">
                  <dt class="text-gray-500 w-24 flex-shrink-0">Security</dt>
                  <dd class="flex flex-wrap gap-1.5">
                    {toolMeta.security.map((feature, i) => {
                      const { label, color } = formatSecurityFeature(feature);
                      return (
                        <span
                          key={i}
                          class={`inline-flex items-center gap-1 px-2 py-0.5 bg-dark-700 rounded text-xs ${color}`}
                        >
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                          </svg>
                          {label}
                        </span>
                      );
                    })}
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
          {(hasMetadata || hasLinks) && (hasGithub || showGithubPlaceholder) && (
            <div class="border-t border-dark-600" />
          )}

          {/* GitHub stats placeholder (unauthenticated) */}
          {showGithubPlaceholder && (
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <span class="text-sm text-gray-500 flex items-center gap-1.5">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  GitHub
                </span>
                <a
                  href="/auth/login"
                  class="flex items-center gap-1.5 px-3 py-1 bg-dark-700 hover:bg-dark-600 border border-dark-500 rounded text-xs text-gray-300 hover:text-white transition-colors"
                >
                  <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  Login to view
                </a>
              </div>
              {/* Greyed out placeholder stats */}
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm opacity-40 select-none">
                <span class="text-gray-500">
                  <span class="text-gray-600">★</span> ---
                </span>
                <span class="text-gray-500">
                  <span class="text-gray-600">⑂</span> --- forks
                </span>
                <span class="text-gray-500">
                  <span class="text-gray-600">○</span> --- issues
                </span>
              </div>
              {/* Placeholder topics */}
              <div class="flex flex-wrap gap-1 opacity-40 select-none">
                <span class="px-2 py-0.5 bg-dark-700 rounded text-xs text-gray-600">topic</span>
                <span class="px-2 py-0.5 bg-dark-700 rounded text-xs text-gray-600">topic</span>
                <span class="px-2 py-0.5 bg-dark-700 rounded text-xs text-gray-600">topic</span>
              </div>
            </div>
          )}

          {/* GitHub stats (auth-gated) */}
          {hasGithub && (
            <div class="space-y-3">
              <span class="text-sm text-gray-500 flex items-center gap-1.5">
                <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                </svg>
                GitHub
              </span>
              {/* Primary stats row */}
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {ghData.stars > 0 && (
                  <span class="text-gray-400">
                    <span class="text-yellow-400">★</span> {ghData.stars.toLocaleString()}
                  </span>
                )}
                {ghData.forks > 0 && (
                  <span class="text-gray-400">
                    <span class="text-gray-500">⑂</span> {ghData.forks.toLocaleString()} forks
                  </span>
                )}
                {ghData.open_issues > 0 && (
                  <span class="text-gray-400">
                    <span class="text-green-400">○</span> {ghData.open_issues.toLocaleString()} issues
                  </span>
                )}
                {ghData.watchers > 0 && (
                  <span class="text-gray-400">
                    <span class="text-gray-500">👁</span> {ghData.watchers.toLocaleString()}
                  </span>
                )}
              </div>
              {/* Secondary info row */}
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                {ghData.language && (
                  <span>{ghData.language}</span>
                )}
                {ghData.pushed_at && (
                  <span>Last push: {formatRelativeTime(ghData.pushed_at)}</span>
                )}
                {ghData.archived && (
                  <span class="text-amber-500">Archived</span>
                )}
              </div>
              {/* Topics */}
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
  data: { daily: Array<{ date: string; count: number }>; monthly: Array<{ month: string; count: number }>; byVersion: Array<{ version: string; count: number }>; byOs: Array<{ os: string | null; count: number }> } | null;
  loading: boolean;
}) {
  const [chartView, setChartView] = useState<ChartView>("30d");

  if (loading) {
    return (
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
        <h2 class="text-lg font-semibold text-gray-200 mb-3">Downloads</h2>
        <div class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <div class="h-5 w-20 bg-dark-600 rounded animate-pulse" />
            <div class="h-6 w-24 bg-dark-600 rounded animate-pulse" />
          </div>
          <div class="h-32 flex items-end gap-0.5">
            {[...Array(30)].map((_, i) => (
              <div key={i} class="flex-1 h-full flex items-end">
                <div
                  class="w-full bg-dark-600 rounded-t animate-pulse"
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
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm text-gray-400">
            {chartView === "30d" ? "Last 30 days" : "Last 12 months"}
          </div>
          <div class="flex rounded-lg overflow-hidden border border-dark-600">
            <button
              onClick={() => setChartView("30d")}
              class={`px-2 py-1 text-xs font-medium transition-colors ${
                chartView === "30d"
                  ? "bg-neon-purple text-white"
                  : "bg-dark-700 text-gray-400 hover:text-gray-200"
              }`}
            >
              30d
            </button>
            <button
              onClick={() => setChartView("12m")}
              class={`px-2 py-1 text-xs font-medium transition-colors ${
                chartView === "12m"
                  ? "bg-neon-purple text-white"
                  : "bg-dark-700 text-gray-400 hover:text-gray-200"
              }`}
            >
              12m
            </button>
          </div>
        </div>
        {chartView === "30d" ? (
          <DailyBarChart daily={data.daily} />
        ) : (
          <MonthlyLineChart monthly={data.monthly || []} />
        )}
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
  const [versionPrefix, setVersionPrefix] = useState("");

  // Find tool metadata from tools.json
  const toolMeta = toolsData?.tools.find((t) => t.name === tool);

  // Update page title
  useEffect(() => {
    document.title = `${tool} - mise tools`;
    return () => {
      document.title = "mise tools";
    };
  }, [tool]);

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

  // Get interesting version prefixes for pill buttons
  const interestingPrefixes = useMemo(() => {
    return getInterestingPrefixes(versions || []);
  }, [versions]);

  // Filter versions by selected prefix
  const filteredVersions = useMemo(() => {
    if (!versionPrefix) return sortedVersions;
    return sortedVersions.filter((v) => v.version.startsWith(versionPrefix + ".") || v.version === versionPrefix);
  }, [sortedVersions, versionPrefix]);

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
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Left column: Info */}
        <InfoPane tool={tool} toolMeta={toolMeta} />

        {/* Right column: Downloads */}
        <DownloadsPane data={downloadData} loading={downloadsLoading} />
      </div>

      {/* Version Timeline */}
      {!loading && versions && versions.length > 0 && (
        <VersionTimeline versions={versions} />
      )}

      {/* Version filter pills */}
      {interestingPrefixes.length > 1 && (
        <div class="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setVersionPrefix("")}
            class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              versionPrefix === ""
                ? "bg-neon-purple text-white"
                : "bg-dark-700 text-gray-400 hover:bg-dark-600 hover:text-gray-200"
            }`}
          >
            All
          </button>
          {interestingPrefixes.map((prefix) => (
            <button
              key={prefix}
              onClick={() => setVersionPrefix(prefix)}
              class={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                versionPrefix === prefix
                  ? "bg-neon-purple text-white"
                  : "bg-dark-700 text-gray-400 hover:bg-dark-600 hover:text-gray-200"
              }`}
            >
              {prefix}
            </button>
          ))}
        </div>
      )}

      {/* Version table */}
      <div class="bg-dark-800 rounded-lg border border-dark-600 overflow-hidden">
        <table class="w-full">
          <thead class="bg-dark-700 border-b border-dark-600">
            <tr>
              <th class="text-left px-4 py-3">
                <SortButton label="Version" sortKey="default" />
                {versionPrefix && (
                  <span class="ml-2 text-xs text-gray-500">
                    ({filteredVersions.length} of {versions?.length})
                  </span>
                )}
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
              filteredVersions.map((v) => (
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
