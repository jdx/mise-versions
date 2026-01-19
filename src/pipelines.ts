export interface PipelinesStreamBinding {
  send(events: unknown[]): Promise<void>;
}

export type TelemetryEventV1 =
  | {
      schema_version: 1;
      type: "download";
      ts: number; // epoch ms
      tool: string;
      version: string;
      os: string | null;
      arch: string | null;
      full: string | null; // backend identifier (e.g. "aqua:nektos/act")
      ip_hash: string;
      mise_version: string | null;
      source: "api/track";
    }
  | {
      schema_version: 1;
      type: "version_request";
      ts: number; // epoch ms
      tool: string;
      ip_hash: string;
      mise_version: string | null;
      source: "toml";
    };

export function getMiseVersionFromUserAgent(
  userAgent: string | null,
): string | null {
  if (!userAgent) return null;

  // Examples we want to match:
  // - "mise/2025.12.0 ..."
  // - "mise 2025.12.0 ..."
  // - "mise/v2025.12.0 ..."
  const m = userAgent.match(
    /\bmise[\/\s]v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?|\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i,
  );
  return m?.[1] ?? null;
}

export function getMiseVersionFromHeaders(headers: Headers): string | null {
  const explicit =
    headers.get("x-mise-version") ??
    headers.get("x-mise-cli-version") ??
    headers.get("x-mise-cli") ??
    null;

  if (explicit) {
    const v = explicit.trim();
    if (v) return v;
  }

  return getMiseVersionFromUserAgent(headers.get("user-agent"));
}

export async function emitTelemetry(
  env: { MISE_VERSIONS_STREAM?: PipelinesStreamBinding },
  event: TelemetryEventV1,
): Promise<void> {
  const stream = env.MISE_VERSIONS_STREAM;
  if (!stream || typeof stream.send !== "function") return;

  try {
    await stream.send([event]);
  } catch (err) {
    // Telemetry must never break primary request path.
    console.error("Failed to send telemetry to Pipelines stream:", err);
  }
}
