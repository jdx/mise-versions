import { useMemo } from "preact/hooks";
import { Link } from "wouter-preact";
import { useTools } from "../hooks/useTools";
import { useAllDownloads } from "../hooks/useAllDownloads";
import { useBackendStats } from "../hooks/useBackendStats";

// Format large numbers compactly (e.g., 1234 -> "1.23k", 1234567 -> "1.23m")
function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + "m";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(n >= 10_000 ? 1 : 2) + "k";
  }
  return n.toString();
}

// Extract backend type from backend string (e.g., "aqua:nektos/act" -> "aqua")
function getBackendType(backend: string): string {
  const colonIndex = backend.indexOf(":");
  return colonIndex > 0 ? backend.slice(0, colonIndex) : backend;
}

// Simple horizontal bar chart component
function BarChart({
  data,
  maxValue,
  formatValue = (v: number) => v.toLocaleString(),
}: {
  data: Array<{ label: string; value: number; color?: string }>;
  maxValue: number;
  formatValue?: (v: number) => string;
}) {
  return (
    <div class="space-y-2">
      {data.map((item) => (
        <div key={item.label} class="flex items-center gap-3">
          <div class="w-20 text-sm text-gray-400 truncate">{item.label}</div>
          <div class="flex-1 h-6 bg-dark-700 rounded overflow-hidden">
            <div
              class="h-full transition-all"
              style={{
                width: `${(item.value / maxValue) * 100}%`,
                backgroundColor: item.color || "#B026FF",
              }}
            />
          </div>
          <div class="w-16 text-sm text-gray-400 text-right">
            {formatValue(item.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

// Helper to create SVG arc path
function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  const start = {
    x: cx + radius * Math.cos(startAngle),
    y: cy + radius * Math.sin(startAngle),
  };
  const end = {
    x: cx + radius * Math.cos(endAngle),
    y: cy + radius * Math.sin(endAngle),
  };
  const largeArcFlag = endAngle - startAngle > Math.PI ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

// Simple pie/donut chart component using arc paths
function DonutChart({
  data,
  size = 360,
}: {
  data: Array<{ label: string; value: number; color: string }>;
  size?: number;
}) {
  // Filter out zero values and ensure we have valid data
  const validData = data.filter((d) => d.value > 0);
  const total = validData.reduce((sum, d) => sum + d.value, 0);

  // Handle empty or invalid data
  if (validData.length === 0 || total === 0) {
    return (
      <div class="flex items-center gap-6">
        <div
          class="rounded-full bg-dark-700 flex items-center justify-center"
          style={{ width: size, height: size }}
        >
          <span class="text-gray-500 text-sm">No data</span>
        </div>
      </div>
    );
  }

  const strokeWidth = 140;
  const radius = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;

  // Start at top (-π/2)
  let currentAngle = -Math.PI / 2;
  const segments = validData.map((d) => {
    const percentage = d.value / total;
    const startAngle = currentAngle;
    // Ensure we don't create a full circle (causes rendering issues)
    const arcLength = percentage * Math.PI * 2 * 0.9999;
    const endAngle = startAngle + arcLength;
    currentAngle = startAngle + percentage * Math.PI * 2;
    return { ...d, startAngle, endAngle, percentage };
  });

  return (
    <div class="flex items-center gap-6">
      <svg width={size} height={size}>
        {segments.map((seg) => (
          <path
            key={seg.label}
            d={describeArc(cx, cy, radius, seg.startAngle, seg.endAngle)}
            fill="none"
            stroke={seg.color}
            strokeWidth={strokeWidth}
            strokeLinecap="butt"
            class="transition-all duration-300"
          />
        ))}
      </svg>
      <div class="space-y-1">
        {segments.slice(0, 6).map((seg) => (
          <div key={seg.label} class="flex items-center gap-2 text-sm">
            <div
              class="w-3 h-3 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            <span class="text-gray-400">{seg.label}</span>
            <span class="text-gray-500">({(seg.percentage * 100).toFixed(1)}%)</span>
          </div>
        ))}
        {segments.length > 6 && (
          <div class="text-xs text-gray-500">+{segments.length - 6} more</div>
        )}
      </div>
    </div>
  );
}

const BACKEND_COLORS: Record<string, string> = {
  aqua: "#00D4FF",
  ubi: "#B026FF",
  asdf: "#FF2D95",
  vfox: "#22C55E",
  cargo: "#F97316",
  npm: "#EF4444",
  go: "#3B82F6",
  pipx: "#8B5CF6",
  core: "#FBBF24",
  gem: "#EC4899",
};

function getBackendColor(backend: string): string {
  return BACKEND_COLORS[backend] || "#6B7280";
}

export function StatsPage() {
  const { data: toolsData, loading: toolsLoading } = useTools();
  const { data: downloads, loading: downloadsLoading } = useAllDownloads();
  const { data: backendStatsData, loading: backendStatsLoading } = useBackendStats();

  const loading = toolsLoading || downloadsLoading || backendStatsLoading;

  // Compute backend statistics (derived from tools.json for tool counts)
  // Only uses the PRIMARY (first) backend for each tool
  const derivedBackendStats = useMemo(() => {
    if (!toolsData?.tools) return { counts: [], downloads: [] };

    const counts = new Map<string, number>();
    const downloadsByBackend = new Map<string, number>();

    for (const tool of toolsData.tools) {
      const toolDownloads = downloads?.[tool.name] || 0;

      // Only use the primary (first) backend
      if (tool.backends && tool.backends.length > 0) {
        const primaryBackend = tool.backends[0];
        const backendType = getBackendType(primaryBackend);
        counts.set(backendType, (counts.get(backendType) || 0) + 1);
        downloadsByBackend.set(
          backendType,
          (downloadsByBackend.get(backendType) || 0) + toolDownloads
        );
      }
    }

    // Sort by count
    const sortedCounts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: getBackendColor(label) }));

    const sortedDownloads = [...downloadsByBackend.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: getBackendColor(label) }));

    return { counts: sortedCounts, downloads: sortedDownloads };
  }, [toolsData?.tools, downloads]);

  // Use real backend stats from tracking data when available, fall back to derived stats
  const backendStats = useMemo(() => {
    // Tool counts always come from tools.json (since that's about which tools support which backends)
    const counts = derivedBackendStats.counts;

    // Downloads: prefer real tracking data if we have it
    const realDownloads = backendStatsData?.downloads_by_backend;
    const hasRealData = realDownloads && realDownloads.length > 0 &&
      realDownloads.some(d => d.backend !== "unknown");

    if (hasRealData) {
      // Use real tracking data
      const downloads = realDownloads
        .filter(d => d.backend !== "unknown") // Filter out unknown backends
        .map(d => ({
          label: d.backend,
          value: d.count,
          color: getBackendColor(d.backend),
        }));
      return { counts, downloads };
    }

    // Fall back to derived stats
    return { counts, downloads: derivedBackendStats.downloads };
  }, [derivedBackendStats, backendStatsData]);

  // Compute total downloads
  const totalDownloads = useMemo(() => {
    if (!downloads) return 0;
    return Object.values(downloads).reduce((sum, count) => sum + count, 0);
  }, [downloads]);

  // Get top tools per backend (derived from tools.json)
  // Only uses the PRIMARY (first) backend for each tool
  const derivedTopToolsByBackend = useMemo(() => {
    if (!toolsData?.tools || !downloads) return new Map();

    const byBackend = new Map<string, Array<{ name: string; downloads: number }>>();

    for (const tool of toolsData.tools) {
      if (!tool.backends || tool.backends.length === 0) continue;
      const toolDownloads = downloads[tool.name] || 0;

      // Only use the primary (first) backend
      const primaryBackend = tool.backends[0];
      const backendType = getBackendType(primaryBackend);
      if (!byBackend.has(backendType)) {
        byBackend.set(backendType, []);
      }
      byBackend.get(backendType)!.push({ name: tool.name, downloads: toolDownloads });
    }

    // Sort each list and keep top 5
    for (const [key, list] of byBackend.entries()) {
      list.sort((a, b) => b.downloads - a.downloads);
      byBackend.set(key, list.slice(0, 5));
    }

    return byBackend;
  }, [toolsData?.tools, downloads]);

  // Use real backend stats from tracking data when available, fall back to derived stats
  const topToolsByBackend = useMemo(() => {
    const realData = backendStatsData?.top_tools_by_backend;
    const hasRealData = realData && Object.keys(realData).length > 0 &&
      Object.keys(realData).some(k => k !== "unknown");

    if (hasRealData) {
      // Convert to Map format, filtering out unknown backend
      const result = new Map<string, Array<{ name: string; downloads: number }>>();
      for (const [backend, tools] of Object.entries(realData)) {
        if (backend === "unknown") continue;
        result.set(backend, tools.map(t => ({ name: t.tool, downloads: t.count })));
      }
      return result;
    }

    return derivedTopToolsByBackend;
  }, [derivedTopToolsByBackend, backendStatsData]);

  if (loading) {
    return (
      <div class="space-y-6">
        <h1 class="text-2xl font-bold text-gray-100">Ecosystem Stats</h1>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} class="bg-dark-800 border border-dark-600 rounded-lg p-6">
              <div class="h-6 w-24 bg-dark-600 rounded animate-pulse mb-2" />
              <div class="h-8 w-32 bg-dark-600 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Select top 5 backends for display (sorted by download count, not tool count)
  const topBackends = backendStats.downloads.slice(0, 5).map((b) => b.label);

  return (
    <div class="space-y-8">
      <div class="flex items-center justify-between">
        <h1 class="text-2xl font-bold text-gray-100">Ecosystem Stats</h1>
        <Link href="/" class="text-sm text-gray-400 hover:text-neon-purple transition-colors">
          ← Back to tools
        </Link>
      </div>

      {/* Overview cards */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="bg-dark-800 border border-dark-600 rounded-lg p-6">
          <div class="text-sm text-gray-400 mb-1">Total Tools</div>
          <div class="text-3xl font-bold text-gray-100">
            {toolsData?.tool_count.toLocaleString()}
          </div>
        </div>
        <div class="bg-dark-800 border border-dark-600 rounded-lg p-6">
          <div class="text-sm text-gray-400 mb-1">Downloads (30d)</div>
          <div class="text-3xl font-bold text-neon-purple">
            {formatCompact(totalDownloads)}
          </div>
        </div>
        <div class="bg-dark-800 border border-dark-600 rounded-lg p-6">
          <div class="text-sm text-gray-400 mb-1">Backends</div>
          <div class="text-3xl font-bold text-gray-100">
            {backendStats.counts.length}
          </div>
        </div>
      </div>

      {/* Charts row */}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tools by backend */}
        <div class="bg-dark-800 border border-dark-600 rounded-lg p-6">
          <h2 class="text-lg font-semibold text-gray-200 mb-4">Tools by Backend</h2>
          <DonutChart data={backendStats.counts.slice(0, 8)} />
        </div>

        {/* Downloads distribution */}
        <div class="bg-dark-800 border border-dark-600 rounded-lg p-6">
          <h2 class="text-lg font-semibold text-gray-200 mb-4">Downloads by Backend</h2>
          <BarChart
            data={backendStats.downloads.slice(0, 10)}
            maxValue={Math.max(...backendStats.downloads.map((b) => b.value))}
            formatValue={formatCompact}
          />
        </div>
      </div>

      {/* Top tools per backend */}
      <div class="bg-dark-800 border border-dark-600 rounded-lg p-6">
        <h2 class="text-lg font-semibold text-gray-200 mb-4">Top Tools by Backend</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-6">
          {topBackends.map((backend) => {
            const tools = topToolsByBackend.get(backend) || [];
            return (
              <div key={backend}>
                <h3 class="text-sm font-medium text-gray-400 mb-2 flex items-center gap-2">
                  <span
                    class="w-2 h-2 rounded-full"
                    style={{ backgroundColor: getBackendColor(backend) }}
                  />
                  {backend}
                </h3>
                <div class="space-y-1">
                  {tools.map((tool: { name: string; downloads: number }, index: number) => (
                    <Link
                      key={tool.name}
                      href={`/tools/${tool.name}`}
                      class="flex items-center justify-between text-sm group"
                    >
                      <span class="text-gray-300 group-hover:text-neon-purple transition-colors truncate">
                        {index + 1}. {tool.name}
                      </span>
                      <span class="text-gray-500 text-xs">
                        {formatCompact(tool.downloads)}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
