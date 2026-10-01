import { Octokit } from "@octokit/rest";
import {
  EMERGENCY_MIN_REMAINING,
  hasBudget,
  MIN_REMAINING,
} from "./token-budget.js";

const HISTORY_HOURS = 24;
const ALERT_REPEAT_HOURS = 12;
const MIN_RATE_INTERVAL_HOURS = 10 / 60;
const MAX_TOKEN_CHECKS_PER_RUN = 45;
const OBSERVATION_INTERVAL_MS = 15 * 60_000;
const TOKEN_CHECK_CONCURRENCY = 5;

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
  checkedTokens: number;
  complete: boolean;
  availableTokens: number;
  rateLimitedTokens: number;
  belowReserveTokens: number;
  invalidTokens: number;
  remaining: number;
  limit: number;
  remainingPercent: number | null;
  // Requests above the lending floor: what the pool can actually still hand out.
  lendable: number;
  lendableLimit: number;
  lendablePercent: number | null;
  quotaBurnPerHour: number | null;
  checkoutRatePerHour: number | null;
  hoursToReserve: number | null;
  nextResetAt: string | null;
};

export type TokenHistoryPoint = {
  observedAt: string;
  remaining: number;
  limit: number;
  lendable: number;
  lendableLimit: number;
  availableTokens: number;
  usageCount: number;
  // Estimated pool spend at this point, null until enough readings exist.
  burnPerHour: number | null;
};

export type PoolGrowthPoint = { date: string; tokens: number };

export type PoolGrowth = {
  total: number;
  contributors: number;
  addedLast7Days: number;
  addedLast30Days: number;
  // Active pool tokens by join date, one point per day (cumulative).
  series: PoolGrowthPoint[];
};

export type TokenObservabilityData = {
  summary: TokenPoolSummary;
  tokens: TokenObservation[];
  history: TokenHistoryPoint[];
  growth: PoolGrowth;
  alerting: {
    configured: boolean;
    recipient: string | null;
    // Set when this check stored its snapshot but could not evaluate or send
    // the alert (for example Resend rejecting the email).
    error?: string | null;
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

export type ObservationRunRow = {
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
      available: !locallyRateLimited && hasBudget(core.remaining),
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
         AND (user_id IS NULL OR user_id != 'jdx')
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id`,
    )
    .bind(now)
    .all<PoolToken>();
  return result.results;
}

type PoolTokenRow = {
  id: number;
  user_id: string | null;
  created_at: string;
};

async function loadPoolTokenRows(
  db: D1Database,
  now: string,
): Promise<PoolTokenRow[]> {
  const result = await db
    .prepare(
      `SELECT id, user_id, created_at
       FROM tokens
       WHERE is_active = 1
         AND (user_id IS NULL OR user_id != 'jdx')
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY id`,
    )
    .bind(now)
    .all<PoolTokenRow>();
  return result.results;
}

const GROWTH_DAYS = 90;
const DAY_MS = 86_400_000;

export function buildPoolGrowth(
  rows: Pick<PoolTokenRow, "user_id" | "created_at">[],
  now: Date,
  days = GROWTH_DAYS,
): PoolGrowth {
  const joined = rows
    .map((row) => Date.parse(row.created_at.replace(" ", "T")))
    .filter((time) => !Number.isNaN(time))
    .sort((a, b) => a - b);
  const startOfToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const series: PoolGrowthPoint[] = [];
  let index = 0;
  for (let offset = days - 1; offset >= 0; offset--) {
    const dayStart = startOfToday - offset * DAY_MS;
    while (index < joined.length && joined[index] < dayStart + DAY_MS) index++;
    series.push({
      date: new Date(dayStart).toISOString().slice(0, 10),
      tokens: index,
    });
  }
  const addedSince = (daysAgo: number) =>
    joined.filter((time) => time >= now.getTime() - daysAgo * DAY_MS).length;
  return {
    total: rows.length,
    contributors: new Set(
      rows.map((row) => row.user_id).filter((id) => id !== null),
    ).size,
    addedLast7Days: addedSince(7),
    addedLast30Days: addedSince(30),
    series,
  };
}

async function storeObservations(
  db: D1Database,
  observedAt: string,
  tokenCount: number,
  observations: TokenObservation[],
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO token_observation_runs (observed_at, token_count)
           VALUES (?, ?)`,
      )
      .bind(observedAt, tokenCount),
    ...observations.map((observation) =>
      db
        .prepare(
          `INSERT INTO token_observations
             (token_id, user_id, user_name, observed_at, remaining,
              limit_count, reset_at, usage_count, is_available, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          observation.tokenId,
          observation.userId,
          observation.userName,
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

export function selectTokenBatch<T>(
  tokens: T[],
  now: Date,
  maximum = MAX_TOKEN_CHECKS_PER_RUN,
): T[] {
  if (tokens.length <= maximum) return tokens;

  const batchCount = Math.ceil(tokens.length / maximum);
  const interval = Math.floor(now.getTime() / OBSERVATION_INTERVAL_MS);
  const batchIndex = interval % batchCount;
  return tokens.slice(batchIndex * maximum, (batchIndex + 1) * maximum);
}

async function inspectTokens(
  tokens: PoolToken[],
  observedAt: string,
): Promise<TokenObservation[]> {
  const observations: TokenObservation[] = [];
  for (let index = 0; index < tokens.length; index += TOKEN_CHECK_CONCURRENCY) {
    observations.push(
      ...(await Promise.all(
        tokens
          .slice(index, index + TOKEN_CHECK_CONCURRENCY)
          .map((token) => inspectToken(token, observedAt)),
      )),
    );
  }
  return observations;
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

function lendableRemaining(token: TokenObservation): number {
  return Math.max(0, (token.remaining ?? 0) - MIN_REMAINING);
}

function lendableCapacity(token: TokenObservation): number {
  return token.remaining === null
    ? 0
    : Math.max(0, (token.limit ?? 0) - MIN_REMAINING);
}

// GitHub quota windows last one hour and begin at a token's first request.
// An idle token reports reset_at = now + 1h, while a busy one reports the end
// of the window that started at reset_at - 1h.
const QUOTA_WINDOW_HOURS = 1;
// Burn is sampled from recent readings only so it tracks current load. Each
// run only checks one batch, so this has to span several runs.
const BURN_SAMPLE_HOURS = 3;
const MIN_BURN_SAMPLE_TOKENS = 20;
const MS_PER_HOUR = 3_600_000;

// Estimates what the whole pool spends per hour from single readings, so it
// works with rotating batches where one token is only seen every few hours.
// Each reading says "this token spent `used` requests over the `elapsed`
// hours since its window began" (or nothing over the last hour if idle). The
// pool rate is total spent over total exposure, scaled to the pool size.
function calculateQuotaBurn(
  observations: TokenObservation[],
  poolSize: number,
): number | null {
  const readings = observations.filter(
    (observation) =>
      !observation.error &&
      observation.remaining !== null &&
      observation.limit !== null &&
      observation.resetAt !== null,
  );
  if (readings.length === 0 || poolSize === 0) return null;

  const newest = Math.max(
    ...readings.map((observation) => Date.parse(observation.observedAt)),
  );
  const cutoff = newest - BURN_SAMPLE_HOURS * MS_PER_HOUR;
  let spent = 0;
  let exposureHours = 0;
  const sampledTokens = new Set<number>();
  for (const reading of readings) {
    const observedAt = Date.parse(reading.observedAt);
    if (observedAt < cutoff) continue;
    const hoursToReset =
      (Date.parse(reading.resetAt as string) - observedAt) / MS_PER_HOUR;
    if (hoursToReset < 0 || hoursToReset > QUOTA_WINDOW_HOURS * 1.01) continue;

    const used = Math.max(
      0,
      (reading.limit as number) - (reading.remaining as number),
    );
    const elapsedHours =
      QUOTA_WINDOW_HOURS - Math.min(QUOTA_WINDOW_HOURS, hoursToReset);
    // A fresh window with nothing spent means no requests for a full hour.
    exposureHours +=
      used === 0 && elapsedHours < 0.02 ? QUOTA_WINDOW_HOURS : elapsedHours;
    spent += used;
    sampledTokens.add(reading.tokenId);
  }
  if (exposureHours === 0) return null;
  if (sampledTokens.size < Math.min(poolSize, MIN_BURN_SAMPLE_TOKENS)) {
    return null;
  }
  return round((spent / exposureHours) * poolSize);
}

// usage_count only ever grows, so any two readings of a token give a valid
// rate. The gap limit has to cover a full rotation of the pool.
function calculateCheckoutRate(
  observations: TokenObservation[],
  poolSize: number,
): number | null {
  const batchCount = Math.ceil(poolSize / MAX_TOKEN_CHECKS_PER_RUN);
  const maxGapHours = Math.max(
    2,
    ((batchCount + 1) * OBSERVATION_INTERVAL_MS) / MS_PER_HOUR + 1,
  );
  const byToken = new Map<number, TokenObservation[]>();
  for (const observation of observations) {
    const entries = byToken.get(observation.tokenId) ?? [];
    entries.push(observation);
    byToken.set(observation.tokenId, entries);
  }

  let checkoutRatePerHour = 0;
  let tokensWithRate = 0;
  for (const entries of byToken.values()) {
    entries.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
    let checkouts = 0;
    let elapsedTotal = 0;
    let previous = entries[0];
    for (let index = 1; index < entries.length; index++) {
      const current = entries[index];
      const elapsedHours =
        (Date.parse(current.observedAt) - Date.parse(previous.observedAt)) /
        MS_PER_HOUR;
      if (elapsedHours < MIN_RATE_INTERVAL_HOURS) continue;
      if (elapsedHours > maxGapHours) {
        previous = current;
        continue;
      }
      const delta = current.usageCount - previous.usageCount;
      if (delta >= 0) {
        checkouts += delta;
        elapsedTotal += elapsedHours;
      }
      previous = current;
    }
    if (elapsedTotal > 0) {
      checkoutRatePerHour += checkouts / elapsedTotal;
      tokensWithRate++;
    }
  }
  if (tokensWithRate === 0) return null;
  // Tokens with no usable pair still exist, so scale the sampled mean up.
  return round((checkoutRatePerHour / tokensWithRate) * poolSize);
}

export function summarizeTokenPool(
  latest: TokenObservation[],
  recent: TokenObservation[],
  observedAt: string | null = latest[0]?.observedAt ?? null,
  tokenCount = latest.length,
): TokenPoolSummary {
  const checkedTokens = latest.length;
  const complete = checkedTokens === tokenCount;
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
      !token.error && token.remaining !== null && !hasBudget(token.remaining),
  ).length;
  const rateLimitedTokens = latest.filter(
    (token) =>
      !token.error &&
      !token.available &&
      token.remaining !== null &&
      hasBudget(token.remaining),
  ).length;
  const currentTokenIds = new Set(latest.map((token) => token.tokenId));
  const currentObservations = recent.filter((token) =>
    currentTokenIds.has(token.tokenId),
  );
  const rates = complete
    ? {
        quotaBurnPerHour: calculateQuotaBurn(
          currentObservations,
          usable.length,
        ),
        checkoutRatePerHour: calculateCheckoutRate(
          currentObservations,
          tokenCount,
        ),
      }
    : { quotaBurnPerHour: null, checkoutRatePerHour: null };
  const usableRemaining = usable.reduce(
    (sum, token) => sum + lendableRemaining(token),
    0,
  );
  const lendableLimit = usable.reduce(
    (sum, token) => sum + lendableCapacity(token),
    0,
  );
  const lendablePercent =
    lendableLimit > 0 ? round((usableRemaining / lendableLimit) * 100) : null;
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
  if (tokenCount === 0) reasons.push("No pool tokens are configured");
  if (!complete) {
    const deferredTokens = tokenCount - checkedTokens;
    reasons.push(
      `${deferredTokens} token${deferredTokens === 1 ? " was" : "s were"} deferred to another check`,
    );
  }
  if (complete && availableTokens === 0) {
    reasons.push(
      `No token has more than ${MIN_REMAINING.toLocaleString()} requests left`,
    );
  } else if (complete && availableTokens === 1) {
    reasons.push(
      `Only one token has more than ${MIN_REMAINING.toLocaleString()} requests left`,
    );
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
  if (complete && lendablePercent !== null && lendablePercent <= 35)
    reasons.push(
      `Only ${lendablePercent}% of lendable quota remains (above the ${MIN_REMAINING.toLocaleString()} floor)`,
    );
  if (hoursToReserve !== null && hoursToReserve <= 6)
    reasons.push(
      `${hoursToReserve}h until the pool reaches reserve at the current burn rate`,
    );

  if (
    tokenCount === 0 ||
    (complete && availableTokens === 0) ||
    (complete && lendablePercent !== null && lendablePercent <= 15) ||
    (hoursToReserve !== null && hoursToReserve <= 2)
  ) {
    level = "critical";
  } else if (
    !complete ||
    (complete && availableTokens <= 1) ||
    invalidTokens > 0 ||
    rateLimitedTokens > 0 ||
    belowReserveTokens > 0 ||
    (lendablePercent !== null && lendablePercent <= 35) ||
    (hoursToReserve !== null && hoursToReserve <= 6)
  ) {
    level = "warning";
  }

  return {
    level,
    reasons,
    observedAt,
    tokenCount,
    checkedTokens,
    complete,
    availableTokens,
    rateLimitedTokens,
    belowReserveTokens,
    invalidTokens,
    remaining,
    limit,
    remainingPercent,
    lendable: usableRemaining,
    lendableLimit,
    lendablePercent,
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
      `SELECT o.token_id, o.user_id, o.user_name, o.observed_at, o.remaining,
              o.limit_count, o.reset_at, o.usage_count, o.is_available, o.error
       FROM token_observations o
       WHERE o.observed_at >= ?
       ORDER BY o.observed_at, o.token_id`,
    )
    .bind(since)
    .all<ObservationRow>();
  return result.results;
}

async function loadLatestObservationRows(
  db: D1Database,
): Promise<ObservationRow[]> {
  const result = await db
    .prepare(
      `SELECT o.token_id, o.user_id, o.user_name, o.observed_at, o.remaining,
              o.limit_count, o.reset_at, o.usage_count, o.is_available, o.error
       FROM token_observations o
       INNER JOIN (
         SELECT token_id, MAX(observed_at) AS observed_at
         FROM token_observations
         GROUP BY token_id
       ) latest
         ON latest.token_id = o.token_id
        AND latest.observed_at = o.observed_at
       ORDER BY o.token_id`,
    )
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

export function selectCurrentObservations(
  observations: TokenObservation[],
  tokenIds: number[],
): TokenObservation[] {
  if (tokenIds.length === 0) return [];

  const currentTokenIds = new Set(tokenIds);
  const latest = new Map<number, TokenObservation>();
  for (const observation of observations) {
    if (currentTokenIds.has(observation.tokenId)) {
      const current = latest.get(observation.tokenId);
      if (!current || observation.observedAt > current.observedAt) {
        latest.set(observation.tokenId, observation);
      }
    }
  }
  return tokenIds.flatMap((tokenId) => {
    const observation = latest.get(tokenId);
    return observation ? [observation] : [];
  });
}

function selectAlertObservations(
  observations: TokenObservation[],
  tokenIds: number[],
  now: Date,
  maximum = MAX_TOKEN_CHECKS_PER_RUN,
): TokenObservation[] {
  const batchCount = Math.ceil(tokenIds.length / maximum);
  const cutoff = now.getTime() - (batchCount + 1) * OBSERVATION_INTERVAL_MS;
  return selectCurrentObservations(
    observations.filter(
      (observation) => Date.parse(observation.observedAt) >= cutoff,
    ),
    tokenIds,
  );
}

// Each run only checks one rotating batch of the pool, so a point is built from
// the newest observation of every token seen within one full rotation (rather
// than from that run's batch alone).
export function historyPoints(
  runs: ObservationRunRow[],
  observations: TokenObservation[],
): TokenHistoryPoint[] {
  const sorted = [...observations].sort((a, b) =>
    a.observedAt.localeCompare(b.observedAt),
  );
  const latest = new Map<number, TokenObservation>();
  const points: TokenHistoryPoint[] = [];
  let next = 0;
  let sampleStart = 0;
  for (const run of runs) {
    while (next < sorted.length && sorted[next].observedAt <= run.observed_at) {
      latest.set(sorted[next].tokenId, sorted[next]);
      next++;
    }
    const runTime = Date.parse(run.observed_at);
    const sampleCutoff = runTime - BURN_SAMPLE_HOURS * MS_PER_HOUR;
    while (
      sampleStart < next &&
      Date.parse(sorted[sampleStart].observedAt) < sampleCutoff
    ) {
      sampleStart++;
    }
    const batchCount = Math.max(
      1,
      Math.ceil(run.token_count / MAX_TOKEN_CHECKS_PER_RUN),
    );
    const cutoff = runTime - (batchCount + 1) * OBSERVATION_INTERVAL_MS;
    const point: TokenHistoryPoint = {
      observedAt: run.observed_at,
      remaining: 0,
      limit: 0,
      lendable: 0,
      lendableLimit: 0,
      availableTokens: 0,
      usageCount: 0,
      burnPerHour: null,
    };
    let covered = 0;
    let usable = 0;
    for (const observation of latest.values()) {
      if (Date.parse(observation.observedAt) < cutoff) continue;
      covered++;
      point.remaining += observation.remaining ?? 0;
      point.limit += observation.limit ?? 0;
      if (!observation.error) {
        usable++;
        point.lendable += lendableRemaining(observation);
        point.lendableLimit += lendableCapacity(observation);
      }
      point.availableTokens += observation.available ? 1 : 0;
      point.usageCount += observation.usageCount;
    }
    if (point.lendableLimit <= 0) continue;
    // Scale to the usable share of the whole pool, as the live tile does.
    const poolSize = Math.round(run.token_count * (usable / covered));
    point.burnPerHour = calculateQuotaBurn(
      sorted.slice(sampleStart, next),
      poolSize,
    );
    points.push(point);
  }
  return points;
}

export async function getTokenObservability(
  env: Env,
  now = new Date(),
): Promise<TokenObservabilityData> {
  const state = await loadTokenObservabilityState(env, now);
  return tokenObservabilityData(env, state);
}

type TokenObservabilityState = {
  observations: TokenObservation[];
  latestObservations: TokenObservation[];
  runs: ObservationRunRow[];
  latestAt: string | undefined;
  currentTokenIds: number[];
  growth: PoolGrowth;
};

async function loadTokenObservabilityState(
  env: Env,
  now: Date,
): Promise<TokenObservabilityState> {
  const since = new Date(
    now.getTime() - HISTORY_HOURS * 3_600_000,
  ).toISOString();
  const observations = (await loadObservationRows(env.DB, since)).map(
    mapObservation,
  );
  const latestObservations = (await loadLatestObservationRows(env.DB)).map(
    mapObservation,
  );
  const runs = await loadObservationRuns(env.DB, since);
  const latestAt = runs.at(-1)?.observed_at;
  const poolTokens = await loadPoolTokenRows(env.DB, now.toISOString());
  return {
    observations,
    latestObservations,
    runs,
    latestAt,
    currentTokenIds: poolTokens.map((token) => token.id),
    growth: buildPoolGrowth(poolTokens, now),
  };
}

function tokenObservabilityData(
  env: Env,
  state: TokenObservabilityState,
): TokenObservabilityData {
  const {
    observations,
    latestObservations,
    runs,
    latestAt,
    currentTokenIds,
    growth,
  } = state;
  const latest = selectCurrentObservations(latestObservations, currentTokenIds);

  return {
    summary: summarizeTokenPool(
      latest,
      observations,
      latestAt ?? null,
      currentTokenIds.length,
    ),
    tokens: latest,
    history: historyPoints(runs, observations),
    growth,
    alerting: {
      configured: Boolean(
        env.RESEND_API_KEY && env.TOKEN_ALERT_TO && env.TOKEN_ALERT_FROM,
      ),
      recipient: env.TOKEN_ALERT_TO ?? null,
    },
  };
}

function alertFingerprint(summary: TokenPoolSummary): string {
  if (!summary.complete) {
    return [
      "partial",
      summary.invalidTokens > 0,
      summary.rateLimitedTokens > 0,
      summary.belowReserveTokens > 0,
    ].join("|");
  }
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
  const availability = summary.complete
    ? `${summary.availableTokens}/${summary.tokenCount}`
    : `${summary.availableTokens}/${summary.checkedTokens} checked (${summary.tokenCount} total)`;
  const quotaLabel = summary.complete
    ? "Lendable quota"
    : "Checked-token lendable quota";
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
        <p><strong>Available tokens:</strong> ${availability}<br>
        <strong>${quotaLabel}:</strong> ${summary.lendable.toLocaleString()} / ${summary.lendableLimit.toLocaleString()} requests above the ${MIN_REMAINING.toLocaleString()} floor (${summary.lendablePercent ?? "unknown"}%)<br>
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

const EMERGENCY_ALERT_LOCK = "token-emergency-alert";
const EMERGENCY_ALERT_TTL_MS = 3_600_000;

// Atomically claim the right to send: an upsert that only succeeds when the
// previous claim has expired, so simultaneous checkouts can't both win.
async function claimEmergencyAlert(db: D1Database): Promise<boolean> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS token_alert_locks (
         name TEXT PRIMARY KEY,
         expires_at TEXT NOT NULL
       )`,
    )
    .run();
  const now = new Date();
  const result = await db
    .prepare(
      `INSERT INTO token_alert_locks (name, expires_at) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET expires_at = excluded.expires_at
       WHERE token_alert_locks.expires_at <= ?`,
    )
    .bind(
      EMERGENCY_ALERT_LOCK,
      new Date(now.getTime() + EMERGENCY_ALERT_TTL_MS).toISOString(),
      now.toISOString(),
    )
    .run();
  return result.meta.changes > 0;
}

// Hand the claim back so the next emergency checkout can retry a failed send.
async function releaseEmergencyAlert(db: D1Database): Promise<void> {
  await db
    .prepare("UPDATE token_alert_locks SET expires_at = ? WHERE name = ?")
    .bind(new Date(0).toISOString(), EMERGENCY_ALERT_LOCK)
    .run();
}

// Called when the token endpoint lends a token that is below the normal floor.
// Emails the maintainer at most once an hour and never throws, so an alerting
// problem can't stop the update job from getting its token.
export async function alertEmergencyTokenUse(
  env: Env,
  info: { tokenId: number; remaining: number; limit: number },
): Promise<void> {
  let claimed = false;
  try {
    console.warn("token_pool_emergency_checkout", info);
    if (!env.RESEND_API_KEY || !env.TOKEN_ALERT_TO || !env.TOKEN_ALERT_FROM)
      return;
    if (!(await claimEmergencyAlert(env.DB))) return;
    claimed = true;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.TOKEN_ALERT_FROM,
        to: env.TOKEN_ALERT_TO,
        subject: "[mise-versions] Token pool emergency: lending low tokens",
        html: `<h2>No token is above ${MIN_REMAINING.toLocaleString()} requests left</h2>
          <p>To keep the update job going, a volunteer's token with only
          <strong>${info.remaining.toLocaleString()} / ${info.limit.toLocaleString()}</strong>
          requests left (token #${info.tokenId}) was lent out. Normally tokens at or below
          ${MIN_REMAINING.toLocaleString()} are left alone; the hard minimum is
          ${EMERGENCY_MIN_REMAINING.toLocaleString()}. This email is sent at most once an hour.</p>
          <p><a href="https://mise-versions.jdx.dev/admin">Open token observability</a></p>`,
      }),
    });
    if (!response.ok) {
      console.error("emergency alert failed", response.status);
      await releaseEmergencyAlert(env.DB);
    }
  } catch (error) {
    console.error("emergency alert error", errorMessage(error));
    // Only hand back a claim we actually hold.
    if (claimed) await releaseEmergencyAlert(env.DB).catch(() => undefined);
  }
}

async function maybeAlert(
  env: Env,
  summary: TokenPoolSummary,
  now: Date,
): Promise<void> {
  if (!shouldEvaluateAlert(summary)) return;

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

export function shouldEvaluateAlert(summary: TokenPoolSummary): boolean {
  return (
    summary.complete ||
    summary.invalidTokens > 0 ||
    summary.rateLimitedTokens > 0 ||
    summary.belowReserveTokens > 0
  );
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
  const tokensToCheck = selectTokenBatch(tokens, now);
  const observations = await inspectTokens(tokensToCheck, observedAt);
  await storeObservations(env.DB, observedAt, tokens.length, observations);
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

  const state = await loadTokenObservabilityState(env, now);
  const data = tokenObservabilityData(env, state);
  const alertObservations = selectAlertObservations(
    state.latestObservations,
    state.currentTokenIds,
    now,
  );
  const alertSummary = summarizeTokenPool(
    alertObservations,
    state.observations,
    state.latestAt ?? null,
    state.currentTokenIds.length,
  );
  // The snapshot is already stored, so a failing alert must not turn the
  // check into a failed request; report it alongside the fresh data instead.
  let alertError: string | null = null;
  try {
    await maybeAlert(env, alertSummary, now);
  } catch (error) {
    alertError = errorMessage(error);
    console.error("token_alert_failed", { error: alertError });
  }
  return { ...data, alerting: { ...data.alerting, error: alertError } };
}
