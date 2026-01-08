import { useState, useEffect } from "preact/hooks";

// Version colors for stacked chart
const VERSION_COLORS = [
  "#B026FF", // Purple
  "#00D4FF", // Cyan
  "#FF2D95", // Pink
  "#22C55E", // Green
  "#F97316", // Orange
  "#3B82F6", // Blue
  "#8B5CF6", // Violet
  "#FBBF24", // Yellow
  "#EF4444", // Red
  "#6B7280", // Gray
];

function formatAxisNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return n.toString();
}

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

  // Fill in missing days for the last 30 days (excluding today since it's incomplete)
  const today = new Date();
  const days: Array<{ date: string; count: number }> = [];
  const dailyMap = new Map(daily.map((d) => [d.date, d.count]));

  for (let i = 30; i >= 1; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    days.push({ date: dateStr, count: dailyMap.get(dateStr) || 0 });
  }

  return (
    <div class="flex">
      {/* Y-axis labels */}
      <div class="flex flex-col justify-between text-xs text-gray-500 pr-2 h-32">
        <span>{formatAxisNumber(maxCount)}</span>
        <span>{formatAxisNumber(Math.round(maxCount / 2))}</span>
        <span>0</span>
      </div>
      {/* Chart */}
      <div class="flex-1 h-32 flex items-end gap-0.5">
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
                {label}: {d.count.toLocaleString()}
              </div>
            </div>
          );
        })}
      </div>
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
    <div class="flex">
      {/* Y-axis labels */}
      <div class="flex flex-col justify-between text-xs text-gray-500 pr-2 h-32">
        <span>{formatAxisNumber(maxCount)}</span>
        <span>{formatAxisNumber(Math.round(maxCount / 2))}</span>
        <span>0</span>
      </div>
      {/* Chart */}
      <div class="flex-1">
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
        </div>
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
    </div>
  );
}

interface VersionTrendData {
  versions: Array<{ version: string; downloads: number; share: number; trend: "growing" | "declining" | "stable" }>;
  timeline: Array<{ date: string; [version: string]: number | string }>;
}

function VersionTrendsChart({
  data,
  loading
}: {
  data: VersionTrendData | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div class="h-32 flex items-center justify-center">
        <div class="text-gray-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!data || data.versions.length === 0) {
    return (
      <div class="h-32 flex items-center justify-center">
        <div class="text-gray-500 text-sm">No version data available</div>
      </div>
    );
  }

  // Get top versions for the chart (max 8)
  const topVersions = data.versions.slice(0, 8);
  const versionKeys = topVersions.map(v => v.version);

  // Build stacked chart data
  const chartHeight = 100;
  const chartWidth = 400;
  const days = data.timeline.length;

  if (days === 0) {
    return (
      <div class="h-32 flex items-center justify-center">
        <div class="text-gray-500 text-sm">No timeline data</div>
      </div>
    );
  }

  // Calculate stacked areas
  const stackedData = data.timeline.map(day => {
    const values: { version: string; y0: number; y1: number }[] = [];
    let cumulative = 0;

    for (const version of versionKeys) {
      const count = (day[version] as number) || 0;
      values.push({
        version,
        y0: cumulative,
        y1: cumulative + count,
      });
      cumulative += count;
    }

    return { date: day.date as string, values, total: cumulative };
  });

  const maxTotal = Math.max(...stackedData.map(d => d.total), 1);

  // Create stacked area paths
  const xScale = (i: number) => (i / Math.max(days - 1, 1)) * chartWidth;
  const yScale = (v: number) => chartHeight - (v / maxTotal) * chartHeight;

  return (
    <div>
      {/* Stacked area chart */}
      <div class="overflow-x-auto mb-3">
        <svg
          width={chartWidth}
          height={chartHeight}
          class="w-full"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
        >
          {/* Stacked areas (render from top to bottom for proper layering) */}
          {[...versionKeys].reverse().map((version, reverseIdx) => {
            const idx = versionKeys.length - 1 - reverseIdx;
            const color = VERSION_COLORS[idx % VERSION_COLORS.length];

            // Build area path
            let path = "";
            for (let i = 0; i < stackedData.length; i++) {
              const x = xScale(i);
              const versionData = stackedData[i].values.find(v => v.version === version);
              const y = versionData ? yScale(versionData.y1) : chartHeight;
              path += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
            }

            // Complete the area by going back along y0
            for (let i = stackedData.length - 1; i >= 0; i--) {
              const x = xScale(i);
              const versionData = stackedData[i].values.find(v => v.version === version);
              const y = versionData ? yScale(versionData.y0) : chartHeight;
              path += ` L ${x} ${y}`;
            }
            path += " Z";

            return (
              <path
                key={version}
                d={path}
                fill={color}
                opacity={0.8}
              >
                <title>{version}</title>
              </path>
            );
          })}
        </svg>
      </div>

      {/* Legend */}
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {topVersions.map((v, idx) => {
          const color = VERSION_COLORS[idx % VERSION_COLORS.length];
          const trendIcon = v.trend === "growing" ? "↑" : v.trend === "declining" ? "↓" : "";
          const trendColor = v.trend === "growing" ? "text-green-400" : v.trend === "declining" ? "text-red-400" : "";

          return (
            <div key={v.version} class="flex items-center gap-1">
              <span
                class="w-2 h-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: color }}
              />
              <span class="font-mono text-gray-400">{v.version}</span>
              <span class="text-gray-500">({v.share.toFixed(0)}%)</span>
              {trendIcon && <span class={trendColor}>{trendIcon}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface DownloadsPaneProps {
  tool: string;
  daily: Array<{ date: string; count: number }>;
  monthly: Array<{ month: string; count: number }>;
  byVersion: Array<{ version: string; count: number }>;
  byOs?: Array<{ os: string | null; count: number }>;
}

const CHART_VIEW_KEY = "mise-downloads-chart-view";
type ChartView = "30d" | "12m" | "versions";

function getStoredChartView(): ChartView {
  if (typeof window === "undefined") return "30d";
  const stored = localStorage.getItem(CHART_VIEW_KEY);
  if (stored === "30d" || stored === "12m" || stored === "versions") return stored;
  return "30d";
}

export function DownloadsPane({ tool, daily, monthly, byVersion, byOs }: DownloadsPaneProps) {
  const [chartView, setChartViewState] = useState<ChartView>("30d");
  const [versionTrendsData, setVersionTrendsData] = useState<VersionTrendData | null>(null);
  const [versionTrendsLoading, setVersionTrendsLoading] = useState(false);

  // Sync from localStorage on mount (after hydration)
  useEffect(() => {
    const stored = getStoredChartView();
    if (stored !== chartView) {
      setChartViewState(stored);
    }
  }, []);

  const setChartView = (view: ChartView) => {
    setChartViewState(view);
    if (typeof window !== "undefined") {
      localStorage.setItem(CHART_VIEW_KEY, view);
    }
  };

  // Fetch version trends when switching to that tab
  useEffect(() => {
    if (chartView === "versions" && !versionTrendsData && !versionTrendsLoading) {
      setVersionTrendsLoading(true);
      fetch(`/api/downloads/${tool}/version-trends?days=30`)
        .then(res => res.json())
        .then(data => {
          setVersionTrendsData(data);
          setVersionTrendsLoading(false);
        })
        .catch(() => {
          setVersionTrendsLoading(false);
        });
    }
  }, [chartView, tool, versionTrendsData, versionTrendsLoading]);

  return (
    <div class="bg-dark-800 border border-dark-600 rounded-lg p-4">
      <h2 class="text-lg font-semibold text-gray-200 mb-3">Downloads</h2>

      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <div class="text-sm text-gray-400">
            {chartView === "30d" ? "Last 30 days" : chartView === "12m" ? "Last 12 months" : "Version trends (30d)"}
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
            <button
              onClick={() => setChartView("versions")}
              class={`px-2 py-1 text-xs font-medium transition-colors ${
                chartView === "versions"
                  ? "bg-neon-purple text-white"
                  : "bg-dark-700 text-gray-400 hover:text-gray-200"
              }`}
            >
              versions
            </button>
          </div>
        </div>
        {chartView === "30d" ? (
          <DailyBarChart daily={daily} />
        ) : chartView === "12m" ? (
          <MonthlyLineChart monthly={monthly || []} />
        ) : (
          <VersionTrendsChart data={versionTrendsData} loading={versionTrendsLoading} />
        )}
      </div>

      {byVersion.length > 0 && (
        <div class="mt-4 pt-4 border-t border-dark-600">
          <div class="text-sm text-gray-400 mb-2">Top versions</div>
          <div class="space-y-1">
            {byVersion.slice(0, 5).map((v) => (
              <div key={v.version} class="flex justify-between text-sm">
                <span class="font-mono text-gray-300">{v.version}</span>
                <span class="text-gray-500">{v.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {byOs && byOs.length > 0 && (
        <div class="mt-4 pt-4 border-t border-dark-600">
          <div class="text-sm text-gray-400 mb-2">By platform</div>
          <div class="flex flex-wrap gap-2">
            {byOs
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
