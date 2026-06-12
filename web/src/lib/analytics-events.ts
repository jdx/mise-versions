import { env } from "cloudflare:workers";

let warnedMissingSqlCredentials = false;

export function analyticsEventsBinding(): AnalyticsEngineDataset | undefined {
  if (
    env.ANALYTICS_EVENTS &&
    (!env.ANALYTICS_ENGINE_ACCOUNT_ID || !env.ANALYTICS_ENGINE_API_TOKEN)
  ) {
    if (!warnedMissingSqlCredentials) {
      warnedMissingSqlCredentials = true;
      console.warn(
        "analytics_events_disabled",
        JSON.stringify({
          reason: "missing_analytics_engine_sql_config",
          has_account_id: Boolean(env.ANALYTICS_ENGINE_ACCOUNT_ID),
          has_api_token: Boolean(env.ANALYTICS_ENGINE_API_TOKEN),
          has_dataset: Boolean(env.ANALYTICS_ENGINE_DATASET),
        }),
      );
    }
    return undefined;
  }

  if (
    !env.ANALYTICS_EVENTS ||
    !env.ANALYTICS_ENGINE_ACCOUNT_ID ||
    !env.ANALYTICS_ENGINE_API_TOKEN
  ) {
    return undefined;
  }

  return env.ANALYTICS_EVENTS;
}
