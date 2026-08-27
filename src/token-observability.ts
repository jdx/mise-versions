import { Octokit } from "@octokit/rest";

const MIN_TOKEN_REMAINING = 1_000;
const HISTORY_HOURS = 24;
const ALERT_REPEAT_HOURS = 12;
const MIN_RATE_INTERVAL_HOURS = 10 / 60;

type PoolToken = {
  id: number;
  user_id: string | null;
  user_name: string | null;
  token: string;
  usage_count: number;
  rate_limited_at: string | null;
};

export type TokenObservation = {
  tokenId: number;
  userId: string | null;
  userName: string | null;
  observedAt: string;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  usageCount: number;
  available: boolean;
  error: string | null;
};

export type TokenRiskLevel = "healthy" | "warning" | "critical";

export type TokenPoolSummary = {
  level: TokenRiskLevel;
  reasons: string[];
  observedAt: string | null;
  tokenCount: number;
  availableTokens: number;
  rateLimitedTokens: number;
  belowReserveTokens: number;
  invalidTokens: number;
  remaining: number;
  limit: number;
  remainingPercent: number | null;
  quotaBurnPerHour: number | null;
  checkoutRatePerHour: number | null;
  hoursToReserve: number | null;
  nextResetAt: string | null;
};

export type TokenHistoryPoint = {
  observedAt: string;
  remaining: number;
  limit: number;
  availableTokens: number;
  usageCount: number;
};

export type TokenObservabilityData = {
  summary: TokenPoolSummary;
  tokens: TokenObservation[];
  history: TokenHistoryPoint[];
  alerting: {
    configured: boolean;
    recipient: string | null;
  };
};

type ObservationRow = {
  token_id: number;
  user_id: string | null;
  user_name: string | null;
  observed_at: string;
  remaining: number | null;
  limit_count: number | null;
  reset_at: string | null;
  usage_count: number;
  is_available: number;
  error: string | null;
};

type ObservationRunRow = {
  observed_at: string;
  token_count: number;
};

export type AlertState = {
  level: TokenRiskLevel;
  fingerprint: string;
  last_sent_at: string | null;
};

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function round(value: number, places = 1): number {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
}

async function inspectToken(
  token: PoolToken,
  observedAt: string,
): Promise<TokenObservation> {
  try {
    const response = await new Octokit({
      auth: token.token,
    }).rest.rateLimit.get();
    const core = response.data.resources.core;
    const resetAt = new Date(core.reset * 1000).toISOString();
    const locallyRateLimited = Boolean(
      token.rate_limited_at && token.rate_limited_at > observedAt,
    );

    return {
      tokenId: token.id,
      userId: token.user_id,
      userName: token.user_name,
      observedAt,
      remaining: core.remaining,
      limit: core.limit,
      resetAt,
      usageCount: token.usage_count,
      available: !locallyRateLimited && core.remaining >= MIN_TOKEN_REMAINING,
      error: null,
    };
  } catch (error) {
    return {
      tokenId: token.id,
      userId: token.user_id,
      userName: token.user_name,
      observedAt,
      remaining: null,
      limit: null,
      resetAt: null,
      usageCount: token.usage_count,
      available: false,
      error: errorMessage(error),
    };
  }
}

async function loadPoolTokens(
  db: D1Database,
  now: string,
): Promise<PoolToken[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, user_name, token, usage_count, rate_limited_at
       FROM tokens
       WHERE is_active = 1
         AND user_id != 'jdx'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id`,
    )
    .bind(now)
    .all<PoolToken>();
  return result.results;
}

async function storeObservations(
  db: D1Database,
  observedAt: string,
  observations: TokenObservation[],
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO token_observation_runs (observed_at, token_count)
           VALUES (?, ?)`,
      )
      .bind(observedAt, observations.length),
    ...observations.map((observation) =>
      db
        .prepare(
          `INSERT INTO token_observations
             (token_id, observed_at, remaining, limit_count, reset_at,
              usage_count, is_available, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          observation.tokenId,
          observation.observedAt,
          observation.remaining,
          observation.limit,
          observation.resetAt,
          observation.usageCount,
          observation.available ? 1 : 0,
          observation.error,
        ),
    ),
  ]);
}

function mapObservation(row: ObservationRow): TokenObservation {
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    userName: row.user_name,
    observedAt: row.observed_at,
    remaining: row.remaining,
    limit: row.limit_count,
    resetAt: row.reset_at,
    usageCount: row.usage_count,
    available: row.is_available === 1,
    error: row.error,
  };
}

function calculateRates(observations: TokenObservation[]): {
  quotaBurnPerHour: number | null;
  checkoutRatePerHour: number | null;
} {
  const byToken = new Map<number, TokenObservation[]>();
  for (const observation of observations) {
    const entries = byToken.get(observation.tokenId) ?? [];
    entries.push(observation);
    byToken.set(observation.tokenId, entries);
  }

  let quotaBurnPerHour = 0;
  let quotaTokensWithRate = 0;
  let checkoutRatePerHour = 0;
  let checkoutTokensWithRate = 0;

  for (const entries of byToken.values()) {
    entries.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    let tokenQuotaConsumed = 0;
    let tokenQuotaElapsedHours = 0;
    let tokenCheckoutCount = 0;
    let tokenCheckoutElapsedHours = 0;
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1];
      const current = entries[index];
      const elapsedHours =
        (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) /
        3_600_000;
      if (elapsedHours < MIN_RATE_INTERVAL_HOURS || elapsedHours > 2) continue;

      const checkoutDelta = current.usageCount - previous.usageCount;
      if (checkoutDelta >= 0) {
        tokenCheckoutCount += checkoutDelta;
        tokenCheckoutElapsedHours += elapsedHours;
      }

      if (
        current.resetAt === previous.resetAt &&
        current.remaining !== null &&
        previous.remaining !== null
      ) {
        const quotaDelta = previous.remaining - current.remaining;
        if (quotaDelta >= 0) {
          tokenQuotaConsumed += quotaDelta;
          tokenQuotaElapsedHours += elapsedHours;
        }
      }
    }
    if (tokenQuotaElapsedHours > 0) {
      quotaBurnPerHour += tokenQuotaConsumed / tokenQuotaElapsedHours;
      quotaTokensWithRate++;
    }
    if (tokenCheckoutElapsedHours > 0) {
      checkoutRatePerHour += tokenCheckoutCount / tokenCheckoutElapsedHours;
      checkoutTokensWithRate++;
    }
  }

  return {
    quotaBurnPerHour: quotaTokensWithRate > 0 ? round(quotaBurnPerHour) : null,
    checkoutRatePerHour:
      checkoutTokensWithRate > 0 ? round(checkoutRatePerHour) : null,
  };
}

export function summarizeTokenPool(
  latest: TokenObservation[],
  recent: TokenObservation[],
  observedAt: string | null = latest[0]?.observedAt ?? null,
): TokenPoolSummary {
  const usable = latest.filter(
    (token) => token.remaining !== null && !token.error,
  );
  const remaining = usable.reduce(
    (sum, token) => sum + (token.remaining ?? 0),
    0,
  );
  const limit = usable.reduce((sum, token) => sum + (token.limit ?? 0), 0);
  const remainingPercent = limit > 0 ? round((remaining / limit) * 100) : null;
  const availableTokens = latest.filter((token) => token.available).length;
  const invalidTokens = latest.filter((token) => token.error).length;
  const belowReserveTokens = latest.filter(
    (token) =>
      !token.error &&
      token.remaining !== null &&
      token.remaining < MIN_TOKEN_REMAINING,
  ).length;
  const rateLimitedTokens = latest.filter(
    (token) =>
      !token.error &&
      !token.available &&
      token.remaining !== null &&
      token.remaining >= MIN_TOKEN_REMAINING,
  ).length;
  const rates = calculateRates(recent);
  const usableRemaining = usable.reduce(
    (sum, token) =>
      sum + Math.max(0, (token.remaining ?? 0) - MIN_TOKEN_REMAINING),
    0,
  );
  const hoursToReserve =
    rates.quotaBurnPerHour && rates.quotaBurnPerHour > 0
      ? round(usableRemaining / rates.quotaBurnPerHour)
      : null;
  const nextResetAt =
    usable
      .map((token) => token.resetAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? null;

  const reasons: string[] = [];
  let level: TokenRiskLevel = "healthy";
  if (latest.length === 0) reasons.push("No pool tokens are configured");
  if (availableTokens === 0) {
    reasons.push("No token has at least 1,000 requests left");
  } else if (availableTokens === 1) {
    reasons.push("Only one token has at least 1,000 requests left");
  }
  if (invalidTokens > 0)
    reasons.push(
      `${invalidTokens} token${invalidTokens === 1 ? "" : "s"} could not be checked`,
    );
  if (rateLimitedTokens > 0)
    reasons.push(
      `${rateLimitedTokens} token${rateLimitedTokens === 1 ? " is" : "s are"} marked rate-limited`,
    );
  if (belowReserveTokens > 0)
    reasons.push(
      `${belowReserveTokens} token${belowReserveTokens === 1 ? " is" : "s are"} below reserve`,
    );
  if (remainingPercent !== null && remainingPercent <= 35)
    reasons.push(`Only ${remainingPercent}% of quota remains`);
  if (hoursToReserve !== null && hoursToReserve <= 6)
    reasons.push(
      `${hoursToReserve}h until the pool reaches reserve at the current burn rate`,
    );

  if (
    latest.length === 0 ||
    availableTokens === 0 ||
    (remainingPercent !== null && remainingPercent <= 15) ||
    (hoursToReserve !== null && hoursToReserve <= 2)
  ) {
    level = "critical";
  } else if (
    availableTokens <= 1 ||
    invalidTokens > 0 ||
    rateLimitedTokens > 0 ||
    belowReserveTokens > 0 ||
    (remainingPercent !== null && remainingPercent <= 35) ||
    (hoursToReserve !== null && hoursToReserve <= 6)
  ) {
    level = "warning";
  }

  return {
    level,
    reasons,
    observedAt,
    tokenCount: latest.length,
    availableTokens,
    rateLimitedTokens,
    belowReserveTokens,
    invalidTokens,
    remaining,
    limit,
    remainingPercent,
    quotaBurnPerHour: rates.quotaBurnPerHour,
    checkoutRatePerHour: rates.checkoutRatePerHour,
    hoursToReserve,
    nextResetAt,
  };
}

async function loadObservationRows(
  db: D1Database,
  since: string,
): Promise<ObservationRow[]> {
  const result = await db
    .prepare(
      `SELECT o.token_id, t.user_id, t.user_name, o.observed_at, o.remaining,
              o.limit_count, o.reset_at, o.usage_count, o.is_available, o.error
       FROM token_observations o
       JOIN tokens t ON t.id = o.token_id
       WHERE o.observed_at >= ?
       ORDER BY o.observed_at, o.token_id`,
    )
    .bind(since)
    .all<ObservationRow>();
  return result.results;
}

async function loadObservationRuns(
  db: D1Database,
  since: string,
): Promise<ObservationRunRow[]> {
  const result = await db
    .prepare(
      `SELECT observed_at, token_count
       FROM token_observation_runs
       WHERE observed_at >= ?
       ORDER BY observed_at`,
    )
    .bind(since)
    .all<ObservationRunRow>();
  return result.results;
}

function latestRun(
  observations: TokenObservation[],
  latestAt: string | undefined,
): TokenObservation[] {
  return latestAt
    ? observations.filter((observation) => observation.observedAt === latestAt)
    : [];
}

function historyPoints(
  runs: ObservationRunRow[],
  observations: TokenObservation[],
): TokenHistoryPoint[] {
  const points = new Map<string, TokenHistoryPoint>(
    runs.map((run) => [
      run.observed_at,
      {
        observedAt: run.observed_at,
        remaining: 0,
        limit: 0,
        availableTokens: 0,
        usageCount: 0,
      },
    ]),
  );
  for (const observation of observations) {
    const point = points.get(observation.observedAt) ?? {
      observedAt: observation.observedAt,
      remaining: 0,
      limit: 0,
      availableTokens: 0,
      usageCount: 0,
    };
    point.remaining += observation.remaining ?? 0;
    point.limit += observation.limit ?? 0;
    point.availableTokens += observation.available ? 1 : 0;
    point.usageCount += observation.usageCount;
    points.set(observation.observedAt, point);
  }
  return [...points.values()];
}

export async function getTokenObservability(
  env: Env,
  now = new Date(),
): Promise<TokenObservabilityData> {
  const since = new Date(
    now.getTime() - HISTORY_HOURS * 3_600_000,
  ).toISOString();
  const observations = (await loadObservationRows(env.DB, since)).map(
    mapObservation,
  );
  const runs = await loadObservationRuns(env.DB, since);
  const latestAt = runs.at(-1)?.observed_at;
  const latest = latestRun(observations, latestAt);

  return {
    summary: summarizeTokenPool(latest, observations, latestAt ?? null),
    tokens: latest,
    history: historyPoints(runs, observations),
    alerting: {
      configured: Boolean(
        env.RESEND_API_KEY && env.TOKEN_ALERT_TO && env.TOKEN_ALERT_FROM,
      ),
      recipient: env.TOKEN_ALERT_TO ?? null,
    },
  };
}

function alertFingerprint(summary: TokenPoolSummary): string {
  return [
    summary.level,
    summary.availableTokens,
    summary.rateLimitedTokens,
    summary.belowReserveTokens,
    summary.invalidTokens,
  ].join("|");
}

async function getAlertState(db: D1Database): Promise<AlertState | null> {
  return await db
    .prepare(
      "SELECT level, fingerprint, last_sent_at FROM token_alert_state WHERE id = 1",
    )
    .first<AlertState>();
}

async function saveAlertState(
  db: D1Database,
  summary: TokenPoolSummary,
  fingerprint: string,
  sentAt: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO token_alert_state (id, level, fingerprint, last_sent_at, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         level = excluded.level,
         fingerprint = excluded.fingerprint,
         last_sent_at = COALESCE(excluded.last_sent_at, token_alert_state.last_sent_at),
         updated_at = excluded.updated_at`,
    )
    .bind(summary.level, fingerprint, sentAt, new Date().toISOString())
    .run();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character];
  });
}

async function sendAlert(
  env: Env,
  summary: TokenPoolSummary,
  recovery: boolean,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.TOKEN_ALERT_TO || !env.TOKEN_ALERT_FROM)
    return;
  const label = recovery ? "recovered" : summary.level;
  const subject = `[mise-versions] Token pool ${label}`;
  const reasons = summary.reasons.length
    ? `<ul>${summary.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>`
    : "<p>The token pool is back within its healthy thresholds.</p>";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.TOKEN_ALERT_FROM,
      to: env.TOKEN_ALERT_TO,
      subject,
      html: `<h2>GitHub token pool ${escapeHtml(label)}</h2>${reasons}
        <p><strong>Available tokens:</strong> ${summary.availableTokens}/${summary.tokenCount}<br>
        <strong>Quota remaining:</strong> ${summary.remaining.toLocaleString()} / ${summary.limit.toLocaleString()} (${summary.remainingPercent ?? "unknown"}%)<br>
        <strong>Quota burn:</strong> ${summary.quotaBurnPerHour?.toLocaleString() ?? "collecting data"}/hour</p>
        <p><a href="https://mise-versions.jdx.dev/admin">Open token observability</a></p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Resend returned ${response.status}: ${(await response.text()).slice(0, 500)}`,
    );
  }
}

async function maybeAlert(
  env: Env,
  summary: TokenPoolSummary,
  now: Date,
): Promise<void> {
  const state = await getAlertState(env.DB);
  const fingerprint = alertFingerprint(summary);
  const { recovery, shouldSend } = getAlertDecision(
    state,
    summary,
    fingerprint,
    now,
  );

  let sentAt: string | null = null;
  if (
    shouldSend &&
    env.RESEND_API_KEY &&
    env.TOKEN_ALERT_TO &&
    env.TOKEN_ALERT_FROM
  ) {
    await sendAlert(env, summary, recovery);
    sentAt = now.toISOString();
  }
  await saveAlertState(env.DB, summary, fingerprint, sentAt);
}

export function getAlertDecision(
  state: AlertState | null,
  summary: TokenPoolSummary,
  fingerprint: string,
  now: Date,
): { recovery: boolean; shouldSend: boolean } {
  const recovery = Boolean(
    summary.level === "healthy" && state && state.level !== "healthy",
  );
  const repeatDue = Boolean(
    summary.level !== "healthy" &&
    state?.last_sent_at &&
    now.getTime() - Date.parse(state.last_sent_at) >=
      ALERT_REPEAT_HOURS * 3_600_000,
  );
  const changed = !state || state.fingerprint !== fingerprint;
  const neverSent = !state?.last_sent_at;
  return {
    recovery,
    shouldSend: Boolean(
      recovery ||
      (summary.level !== "healthy" && (changed || repeatDue || neverSent)),
    ),
  };
}

export async function observeTokenPool(
  env: Env,
  now = new Date(),
): Promise<TokenObservabilityData> {
  const observedAt = now.toISOString();
  const tokens = await loadPoolTokens(env.DB, observedAt);
  const observations = await Promise.all(
    tokens.map((token) => inspectToken(token, observedAt)),
  );
  await storeObservations(env.DB, observedAt, observations);
  const retentionCutoff = new Date(
    now.getTime() - 30 * 86_400_000,
  ).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM token_observations WHERE observed_at < ?").bind(
      retentionCutoff,
    ),
    env.DB.prepare(
      "DELETE FROM token_observation_runs WHERE observed_at < ?",
    ).bind(retentionCutoff),
  ]);

  const data = await getTokenObservability(env, now);
  await maybeAlert(env, data.summary, now);
  return data;
}
