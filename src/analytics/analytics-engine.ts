export const ANALYTICS_EVENTS_DATASET = "mise_analytics_events";

export interface AnalyticsEngineSqlConfig {
  accountId?: string;
  apiToken?: string;
  dataset?: string;
  cutoverDate?: string;
}

export interface AnalyticsEngineQueryResult<T> {
  rows: T[];
}

const ANALYTICS_ENGINE_RETRY_ATTEMPTS = 3;

function backendType(full: string | null): string {
  return full?.split(":")[0] || "unknown";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableAnalyticsEngineFailure(status: number) {
  return status === 429 || status >= 500;
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
  return Boolean(
    config?.accountId && config?.apiToken && analyticsEngineDataset(config),
  );
}

export function analyticsEngineDataset(config?: AnalyticsEngineSqlConfig) {
  return config?.dataset || ANALYTICS_EVENTS_DATASET;
}

export function analyticsEngineCutoverDate(
  config?: AnalyticsEngineSqlConfig,
): string | undefined {
  const cutoverDate = config?.cutoverDate;
  if (!cutoverDate) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoverDate)) {
    throw new Error(`Invalid Analytics Engine cutover date: ${cutoverDate}`);
  }
  return cutoverDate;
}

export function analyticsEngineCoversDate(
  config: AnalyticsEngineSqlConfig | undefined,
  date: string,
): boolean {
  const cutoverDate = analyticsEngineCutoverDate(config);
  return !cutoverDate || date >= cutoverDate;
}

export async function queryAnalyticsEngine<T>(
  config: AnalyticsEngineSqlConfig,
  query: string,
): Promise<AnalyticsEngineQueryResult<T>> {
  if (!config.accountId || !config.apiToken) {
    throw new Error("Analytics Engine SQL credentials are not configured");
  }

  for (let attempt = 0; attempt <= ANALYTICS_ENGINE_RETRY_ATTEMPTS; attempt++) {
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
      if (
        attempt < ANALYTICS_ENGINE_RETRY_ATTEMPTS &&
        isRetryableAnalyticsEngineFailure(response.status)
      ) {
        const delay = 2 ** attempt * 1000;
        console.warn(
          `Analytics Engine query failed: ${response.status} ${text}; retrying in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

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

  // Unreachable in practice: the bounded loop returns, throws, or continues on
  // every iteration. Keep this to satisfy TypeScript control-flow analysis.
  throw new Error("Analytics Engine query failed after retries");
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
