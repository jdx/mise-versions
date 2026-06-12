import { env } from "cloudflare:workers";

export function analyticsEventsBinding(): AnalyticsEngineDataset | undefined {
  if (!env.ANALYTICS_ENGINE_ACCOUNT_ID || !env.ANALYTICS_ENGINE_API_TOKEN) {
    return undefined;
  }

  return env.ANALYTICS_EVENTS;
}
