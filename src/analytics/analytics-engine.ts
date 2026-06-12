export const ANALYTICS_EVENTS_DATASET = "mise_analytics_events";

export interface AnalyticsEngineSqlConfig {
  accountId?: string;
  apiToken?: string;
  dataset?: string;
}

export interface AnalyticsEngineQueryResult<T> {
  rows: T[];
}

function backendType(full: string | null): string {
  return full?.split(":")[0] || "unknown";
}

export function writeDownloadEvent(
  dataset: AnalyticsEngineDataset | undefined,
  event: {
    tool: string;
    version: string;
    ipHash: string;
    os: string | null;
    arch: string | null;
    full: string | null;
  },
): boolean {
  if (!dataset) return false;

  dataset.writeDataPoint({
    blobs: [
      "download",
      event.tool,
      event.version,
      event.os || "",
      event.arch || "",
      event.full || "",
      backendType(event.full),
    ],
    doubles: [1],
    indexes: [event.ipHash],
  });
  return true;
}

export function writeVersionRequestEvent(
  dataset: AnalyticsEngineDataset | undefined,
  ipHash: string,
): boolean {
  if (!dataset) return false;

  dataset.writeDataPoint({
    blobs: ["version_request", "", "", "", "", "", ""],
    doubles: [1],
    indexes: [ipHash],
  });
  return true;
}

export function hasAnalyticsEngineSql(config?: AnalyticsEngineSqlConfig) {
  return Boolean(config?.accountId && config?.apiToken && config?.dataset);
}

export function analyticsEngineDataset(config?: AnalyticsEngineSqlConfig) {
  return config?.dataset || ANALYTICS_EVENTS_DATASET;
}

export async function queryAnalyticsEngine<T>(
  config: AnalyticsEngineSqlConfig,
  query: string,
): Promise<AnalyticsEngineQueryResult<T>> {
  if (!config.accountId || !config.apiToken) {
    throw new Error("Analytics Engine SQL credentials are not configured");
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
      },
      body: `${query}\nFORMAT JSON`,
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Analytics Engine query failed: ${response.status} ${text}`,
    );
  }

  try {
    const parsed = JSON.parse(text) as { data?: T[]; errors?: unknown };
    if (Array.isArray(parsed.data)) {
      return { rows: parsed.data };
    }
  } catch {
    // Fall through to a clearer error below.
  }

  throw new Error(
    `Unexpected Analytics Engine response: ${text.slice(0, 200)}`,
  );
}

export function dateRangeSql(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date for Analytics Engine query: ${date}`);
  }
  return {
    start: `${date} 00:00:00`,
    end: `${date} 23:59:59`,
  };
}
