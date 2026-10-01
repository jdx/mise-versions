// These bindings are optional because Analytics Engine SQL queries fall back
// to D1 when the credentials are not configured.
interface Env {
  ANALYTICS_ENGINE_ACCOUNT_ID?: string;
  ANALYTICS_ENGINE_API_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    ANALYTICS_ENGINE_ACCOUNT_ID?: string;
    ANALYTICS_ENGINE_API_TOKEN?: string;
  }
}
