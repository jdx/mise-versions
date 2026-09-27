import { env } from "cloudflare:workers";

export function analyticsEventsBinding(): AnalyticsEngineDataset | undefined {
  return env.ANALYTICS_EVENTS;
}
