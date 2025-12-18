import { useState, useEffect } from "preact/hooks";
import { BadgeModal } from "./BadgeModal";

interface SecurityFeature {
  type: string;
  algorithm?: string;
}

interface ToolMeta {
  name: string;
  description?: string;
  license?: string;
  homepage?: string;
  repo_url?: string;
  github?: string;
  backends?: string[];
  authors?: string[];
  security?: SecurityFeature[];
  package_urls?: Record<string, string>;
  aqua_link?: string;
}

interface GithubData {
  stars: number;
  forks: number;
  open_issues: number;
  watchers: number;
  language: string | null;
  topics: string[];
  pushed_at: string | null;
  archived: boolean;
}

const packageUrlLabels: Record<string, string> = {
  npm: "npm",
  cargo: "crates.io",
  pypi: "PyPI",
  rubygems: "RubyGems",
  go: "pkg.go.dev",
};

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

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

function parseGithubSlug(github: string): { owner: string; repo: string } | null {
  const parts = github.split("/");
  if (parts.length >= 2) {
    return { owner: parts[0], repo: parts[1] };
  }
  return null;
}

interface InfoPaneProps {
  tool: string;
  toolMeta: ToolMeta | undefined;
}

export function InfoPane({ tool, toolMeta }: InfoPaneProps) {
  const [showBadgeModal, setShowBadgeModal] = useState(false);
  const [ghData, setGhData] = useState<GithubData | null>(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghStale, setGhStale] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);

  // Check auth status
  useEffect(() => {
    fetch("/api/auth/me")
      .then(res => res.json())
      .then(data => setAuthenticated(data.authenticated))
      .catch(() => {});
  }, []);

  // Fetch GitHub data
  const parsed = toolMeta?.github ? parseGithubSlug(toolMeta.github) : null;

  useEffect(() => {
    if (!parsed) return;

    setGhLoading(true);
    fetch(`/api/github/repo?owner=${parsed.owner}&repo=${parsed.repo}`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setGhData(null);
        } else {
          setGhData(data);
          setGhStale(data.stale || false);
        }
        setGhLoading(false);
      })
      .catch(() => {
        setGhLoading(false);
      });
  }, [parsed?.owner, parsed?.repo]);

  const hasMetadata = toolMeta && (toolMeta.license || toolMeta.homepage || toolMeta.repo_url || toolMeta.authors?.length || toolMeta.security?.length);
  const hasLinks = toolMeta && (toolMeta.package_urls || toolMeta.aqua_link || toolMeta.backends?.length);
  const hasGithub = ghData && (ghData.stars > 0 || (ghData.topics && ghData.topics.length > 0));
  const showGithubPlaceholder = !ghData && !ghLoading && !authenticated && parsed !== null;

  // Get current page path for return_to
  const currentPath = typeof window !== 'undefined' ? window.location.pathname : '/';
  const loginUrl = `/api/auth/login?return_to=${encodeURIComponent(currentPath)}`;

  return (
    <div class="space-y-4">
      {/* Install command */}
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
        <div class="flex items-center justify-between mb-1">
          <div class="text-sm text-gray-400">Install with mise:</div>
          <button
            onClick={() => setShowBadgeModal(true)}
            class="text-xs text-neon-blue hover:text-neon-purple transition-colors flex items-center gap-1"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
            </svg>
            Get Badge
          </button>
        </div>
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
                  href={loginUrl}
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
              {/* Stale data warning */}
              {ghStale && !authenticated && (
                <div class="text-xs text-amber-500 flex items-center gap-1.5">
                  <span>Data may be outdated.</span>
                  <a
                    href={loginUrl}
                    class="underline hover:text-amber-400 transition-colors"
                  >
                    Login to refresh
                  </a>
                </div>
              )}
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

      {/* Badge Modal */}
      {showBadgeModal && (
        <BadgeModal tool={tool} onClose={() => setShowBadgeModal(false)} />
      )}
    </div>
  );
}
