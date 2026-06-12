import { env } from "cloudflare:workers";

export function analyticsEventsBinding(): AnalyticsEngineDataset | undefined {
  if (
    !env.ANALYTICS_EVENTS ||
    !env.ANALYTICS_ENGINE_ACCOUNT_ID ||
    !env.ANALYTICS_ENGINE_API_TOKEN ||
    !env.ANALYTICS_ENGINE_DATASET
  ) {
    return undefined;
  }

  return env.ANALYTICS_EVENTS;
}
