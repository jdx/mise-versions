/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPoolGrowth,
  getAlertDecision,
  historyPoints,
  observeTokenPool,
  selectCurrentObservations,
  selectTokenBatch,
  shouldEvaluateAlert,
  summarizeTokenPool,
  type AlertState,
  type TokenObservation,
} from "./token-observability.js";

test("builds history from rotating batches of a larger pool", () => {
  // Each run observes only part of the pool; later points reuse earlier readings.
  const runs = [
    { observed_at: "2026-08-27T12:00:00.000Z", token_count: 2 },
    { observed_at: "2026-08-27T12:15:00.000Z", token_count: 3 },
  ];
  const observations = [
    observation(1, "2026-08-27T12:00:00.000Z", 5_000, 1),
    observation(2, "2026-08-27T12:00:00.000Z", 4_000, 1),
    observation(3, "2026-08-27T12:15:00.000Z", 3_000, 1),
    observation(2, "2026-08-27T12:15:00.000Z", 5_000, 2),
  ];

  const points = historyPoints(runs, observations);

  assert.equal(points.length, 2);
  assert.equal(points[0].remaining, 9_000);
  assert.equal(points[0].limit, 10_000);
  // Only requests above the 4k floor are lendable: (5000-4000) + (4000-4000).
  assert.equal(points[0].lendable, 1_000);
  assert.equal(points[0].lendableLimit, 2_000);
  // Token 1 carries over from the previous run; token 2 is replaced by its newer reading.
  assert.equal(points[1].remaining, 13_000);
  assert.equal(points[1].limit, 15_000);
  assert.deepEqual(historyPoints(runs, []), []);
});

test("builds a cumulative pool growth series by join date", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");
  const rows = [
    { user_id: "a", created_at: "2026-09-01T10:00:00.000Z" },
    { user_id: "b", created_at: "2026-09-29 08:00:00" },
    { user_id: "b", created_at: "2026-09-30T23:00:00.000Z" },
    { user_id: null, created_at: "2026-10-01T01:00:00.000Z" },
    { user_id: "c", created_at: "2025-01-01T00:00:00.000Z" },
  ];

  const growth = buildPoolGrowth(rows, now, 5);

  assert.deepEqual(
    growth.series.map((point) => point.date),
    ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"],
  );
  assert.deepEqual(
    growth.series.map((point) => point.tokens),
    [2, 2, 3, 4, 5],
  );
  assert.equal(growth.total, 5);
  // Distinct users, not counting tokens with no user.
  assert.equal(growth.contributors, 3);
  assert.equal(growth.addedLast7Days, 3);
  assert.equal(growth.addedLast30Days, 3);
});

test("history skips points that cover only part of the pool", () => {
  const runs = [
    { observed_at: "2026-08-27T12:00:00.000Z", token_count: 4 },
    { observed_at: "2026-08-27T12:15:00.000Z", token_count: 4 },
  ];
  const observations = [
    observation(1, "2026-08-27T12:00:00.000Z", 5_000, 0),
    observation(2, "2026-08-27T12:00:00.000Z", 5_000, 0),
    observation(3, "2026-08-27T12:15:00.000Z", 5_000, 0),
    observation(4, "2026-08-27T12:15:00.000Z", 5_000, 0),
  ];

  const points = historyPoints(runs, observations);

  // The first run has seen only 2 of 4 tokens; the second has seen all four.
  assert.deepEqual(
    points.map((point) => point.observedAt),
    ["2026-08-27T12:15:00.000Z"],
  );
});

test("history points carry an estimated burn per run", () => {
  const at = "2026-08-27T13:00:00.000Z";
  const tokens = Array.from({ length: 30 }, (_, index) => index + 1);
  const observations = tokens.map((id) =>
    observation(id, at, 4_900, 0, HALF_SPENT_WINDOW),
  );

  const [point] = historyPoints(
    [{ observed_at: at, token_count: 30 }],
    observations,
  );

  // 100 spent over half an hour per token, 30 tokens.
  assert.equal(point.burnPerHour, 6_000);
});

test("reports lendable quota above the reserve floor", () => {
  const now = "2026-08-27T13:00:00.000Z";
  const latest = [
    observation(1, now, 5_000, 1),
    observation(2, now, 4_500, 1),
    observation(3, now, 4_000, 1),
    {
      ...observation(4, now, 0, 1),
      remaining: null,
      limit: null,
      error: "bad",
    },
  ];

  const summary = summarizeTokenPool(latest, latest, now, 4);

  assert.equal(summary.lendable, 1_500);
  assert.equal(summary.lendableLimit, 3_000);
  assert.equal(summary.lendablePercent, 50);
  // The raw percentage used by alert thresholds is unchanged.
  assert.equal(summary.remainingPercent, 90);
});

test("alerts on lendable quota rather than raw quota", () => {
  const now = "2026-08-27T13:00:00.000Z";
  // 80% raw quota left, but every token is only 300 requests above the floor.
  const tokens = [1, 2, 3].map((id) => observation(id, now, 4_300, 1));

  const summary = summarizeTokenPool(tokens, tokens, now, 3);

  assert.equal(summary.remainingPercent, 86);
  assert.equal(summary.lendablePercent, 30);
  assert.equal(summary.level, "warning");
  assert.ok(summary.reasons.some((reason) => reason.includes("30%")));

  const nearlyDry = [1, 2, 3].map((id) => observation(id, now, 4_100, 1));
  assert.equal(
    summarizeTokenPool(nearlyDry, nearlyDry, now, 3).level,
    "critical",
  );
});

test("rotates bounded token batches between observation intervals", () => {
  const tokens = [1, 2, 3, 4, 5];

  assert.deepEqual(
    selectTokenBatch(tokens, new Date("1970-01-01T00:00:00.000Z"), 2),
    [1, 2],
  );
  assert.deepEqual(
    selectTokenBatch(tokens, new Date("1970-01-01T00:15:00.000Z"), 2),
    [3, 4],
  );
  assert.deepEqual(
    selectTokenBatch(tokens, new Date("1970-01-01T00:30:00.000Z"), 2),
    [5],
  );
});

test("combines fresh rotating batches for the current pool", () => {
  const now = new Date("2026-08-27T13:00:00.000Z");
  const stale = observation(1, "2026-08-27T12:00:00.000Z", 4_950, 1);
  const tokenOne = observation(1, "2026-08-27T12:45:00.000Z", 4_900, 2);
  const tokenTwo = observation(2, "2026-08-27T12:30:00.000Z", 4_800, 3);
  const deleted = observation(3, "2026-08-27T12:50:00.000Z", 4_700, 4);

  const current = selectCurrentObservations(
    [stale, tokenTwo, tokenOne, deleted],
    [1, 2],
  );

  assert.deepEqual(current, [tokenOne, tokenTwo]);
  const summary = summarizeTokenPool(current, current, now.toISOString(), 2);
  assert.equal(summary.complete, true);
  assert.equal(
    getAlertDecision(
      {
        level: "warning",
        fingerprint: "unhealthy",
        last_sent_at: "2026-08-27T12:00:00.000Z",
      },
      summary,
      "healthy",
      now,
    ).recovery,
    true,
  );
});

test("keeps the last-known snapshot when scheduled checks are delayed", () => {
  const lastKnown = observation(1, "2026-08-27T12:00:00.000Z", 4_500, 1);

  assert.deepEqual(selectCurrentObservations([lastKnown], [1]), [lastKnown]);
});

function observation(
  tokenId: number,
  observedAt: string,
  remaining: number,
  usageCount: number,
  // Defaults to a fresh window (reset in an hour), which carries no burn sample.
  resetAt = new Date(Date.parse(observedAt) + 3_600_000).toISOString(),
): TokenObservation {
  return {
    tokenId,
    userId: `user-${tokenId}`,
    userName: null,
    observedAt,
    remaining,
    limit: 5_000,
    resetAt,
    usageCount,
    available: remaining > 4_000,
    error: null,
  };
}

const HALF_SPENT_WINDOW = "2026-08-27T13:30:00.000Z";

test("estimates pool burn from single readings scaled to the pool", () => {
  const at = "2026-08-27T13:00:00.000Z";
  // Windows are half over (reset in 30m): token 1 spent 200, token 2 spent 400.
  const readings = [
    observation(1, at, 4_800, 10, HALF_SPENT_WINDOW),
    observation(2, at, 4_600, 20, HALF_SPENT_WINDOW),
  ];

  const summary = summarizeTokenPool(readings, readings, at, 2);

  // 200/0.5h + 400/0.5h
  assert.equal(summary.quotaBurnPerHour, 1_200);
});

test("scales sampled burn up to tokens that were not in the sample", () => {
  const at = "2026-08-27T13:00:00.000Z";
  const readings = Array.from({ length: 4 }, (_, index) =>
    observation(index + 1, at, 4_900, 0, HALF_SPENT_WINDOW),
  );

  // One reading per token, 100 spent over half an hour each.
  assert.equal(
    summarizeTokenPool(readings, readings, at, 4).quotaBurnPerHour,
    800,
  );
});

test("does not count repeated readings of one window again", () => {
  const window = "2026-08-27T13:00:00.000Z";
  // A burst of 1000 requests early in the window, re-read every 15 minutes.
  const readings = ["12:15", "12:30", "12:45"].map((time) =>
    observation(1, `2026-08-27T${time}:00.000Z`, 4_000, 0, window),
  );

  const summary = summarizeTokenPool(
    readings.slice(-1),
    readings,
    "2026-08-27T12:45:00.000Z",
    1,
  );

  // Newest reading only: 1000 requests over the 0.75h since the window began.
  assert.equal(Math.round(summary.quotaBurnPerHour ?? 0), 1_333);
});

test("keeps spend from an earlier window when the newest reading follows a reset", () => {
  // Busy until the 12:00 reset (2000 spent over 50 minutes), then a fresh
  // window at 12:05. Using only the newest reading would report zero.
  const readings = [
    observation(
      1,
      "2026-08-27T11:50:00.000Z",
      3_000,
      0,
      "2026-08-27T12:00:00.000Z",
    ),
    observation(
      1,
      "2026-08-27T12:05:00.000Z",
      5_000,
      0,
      "2026-08-27T13:05:00.000Z",
    ),
  ];

  const summary = summarizeTokenPool(
    readings.slice(-1),
    readings,
    "2026-08-27T12:05:00.000Z",
    1,
  );

  // 2000 over 0.8333h of busy window plus the 5 minutes since the reset.
  assert.equal(Math.round(summary.quotaBurnPerHour ?? 0), 2_182);
});

test("counts idle tokens as an hour without spend", () => {
  const at = "2026-08-27T13:00:00.000Z";
  const idle = (id: number) =>
    observation(id, at, 5_000, 0, "2026-08-27T14:00:00.000Z");
  const busy = observation(3, at, 4_000, 0, "2026-08-27T13:30:00.000Z");
  const readings = [idle(1), idle(2), busy];

  const summary = summarizeTokenPool(readings, readings, at, 3);

  // 1000 spent over 0.5h + two idle hours = 2.5 exposure hours, times 3 tokens.
  assert.equal(summary.quotaBurnPerHour, 1_200);
  assert.equal(
    summarizeTokenPool([idle(1)], [idle(1)], at, 1).quotaBurnPerHour,
    0,
  );
});

test("keeps burn in a learning state without usable window data", () => {
  const at = "2026-08-27T13:00:00.000Z";
  const reading = { ...observation(1, at, 4_800, 1), resetAt: null };

  const summary = summarizeTokenPool([reading], [reading], at, 1);

  assert.equal(summary.quotaBurnPerHour, null);
  assert.equal(summary.hoursToReserve, null);
});

test("ignores readings older than the burn sample and deleted tokens", () => {
  const stale = "2026-08-27T08:00:00.000Z";
  const at = "2026-08-27T13:00:00.000Z";
  const current = observation(1, at, 4_800, 12, HALF_SPENT_WINDOW);
  const recent = [
    // Spent a lot, but five hours ago.
    observation(1, stale, 1_000, 10, "2026-08-27T08:30:00.000Z"),
    // Deleted token.
    observation(2, at, 1_000, 30),
    current,
  ];

  const summary = summarizeTokenPool([current], recent, at, 1);

  assert.equal(summary.quotaBurnPerHour, 400);
});

test("derives hours to reserve from the estimated burn", () => {
  const at = "2026-08-27T13:00:00.000Z";
  const readings = [
    observation(1, at, 4_800, 0, HALF_SPENT_WINDOW),
    observation(2, at, 4_800, 0, HALF_SPENT_WINDOW),
  ];

  const summary = summarizeTokenPool(readings, readings, at, 2);

  // 800 requests/h across the pool, 1600 above the floor.
  assert.equal(summary.quotaBurnPerHour, 800);
  assert.equal(summary.hoursToReserve, 2);
  assert.equal(summary.level, "critical");
});

test("measures checkout rate across a full rotation gap", () => {
  // A pool of 1248 tokens is only observed once every ~7 hours.
  const ids = Array.from({ length: 1_248 }, (_, index) => index + 1);
  const earlier = ids.map((id) =>
    observation(id, "2026-08-27T06:00:00.000Z", 5_000, 100),
  );
  const latest = ids.map((id) =>
    observation(id, "2026-08-27T13:00:00.000Z", 5_000, 170),
  );

  const summary = summarizeTokenPool(
    latest,
    [...earlier, ...latest],
    "2026-08-27T13:00:00.000Z",
  );

  assert.equal(summary.checkoutRatePerHour, 12_480);
});

test("ignores short manual-check gaps when calculating checkouts", () => {
  const previous = "2026-08-27T12:00:00.000Z";
  const current = "2026-08-27T12:01:00.000Z";
  const recent = [
    observation(1, previous, 4_900, 10),
    observation(2, previous, 4_900, 20),
    observation(1, current, 4_800, 12),
    observation(2, current, 4_800, 23),
  ];

  const summary = summarizeTokenPool(recent.slice(-2), recent);

  assert.equal(summary.level, "healthy");
  assert.equal(summary.checkoutRatePerHour, null);
});

test("bridges manual checks when a full rate interval is available", () => {
  const recent = [
    observation(1, "2026-08-27T12:00:00.000Z", 4_900, 10),
    observation(1, "2026-08-27T12:05:00.000Z", 4_850, 11),
    observation(1, "2026-08-27T12:15:00.000Z", 4_750, 13),
  ];

  const summary = summarizeTokenPool(recent.slice(-1), recent);

  assert.equal(summary.checkoutRatePerHour, 12);
});

test("marks a bounded observation as incomplete without a false critical", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 500, 12);
  const summary = summarizeTokenPool(
    [current],
    [current],
    current.observedAt,
    60,
  );

  assert.equal(summary.level, "warning");
  assert.equal(summary.complete, false);
  assert.equal(summary.checkedTokens, 1);
  assert.equal(summary.tokenCount, 60);
  assert.equal(summary.quotaBurnPerHour, null);
  assert.doesNotMatch(summary.reasons.join(" "), /No token has/);
  assert.equal(shouldEvaluateAlert(summary), true);
});

test("does not alert on a partial rotation with healthy quota", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_900, 12);
  const summary = summarizeTokenPool(
    [current],
    [current],
    current.observedAt,
    60,
  );

  assert.equal(summary.level, "healthy");
  assert.deepEqual(summary.reasons, []);
  assert.equal(shouldEvaluateAlert(summary), false);
});

test("stays healthy with a few unreachable, rate-limited or low tokens", () => {
  const now = "2026-08-27T13:00:00.000Z";
  const tokens = Array.from({ length: 100 }, (_, index) =>
    observation(index + 1, now, 4_950, 1),
  );
  tokens[0] = {
    ...observation(1, now, 0, 1),
    remaining: null,
    limit: null,
    error: "bad credentials",
  };
  tokens[1].available = false;
  tokens[2] = observation(3, now, 3_000, 1);

  const summary = summarizeTokenPool(tokens, tokens, now, 100);

  assert.equal(summary.invalidTokens, 1);
  assert.equal(summary.rateLimitedTokens, 1);
  assert.equal(summary.belowReserveTokens, 1);
  assert.equal(summary.level, "healthy");
  assert.deepEqual(summary.reasons, []);
});

test("warns when a tenth of the pool cannot be checked", () => {
  const now = "2026-08-27T13:00:00.000Z";
  const tokens = Array.from({ length: 20 }, (_, index) =>
    index < 2
      ? {
          ...observation(index + 1, now, 0, 1),
          remaining: null,
          limit: null,
          error: "GitHub is down",
        }
      : observation(index + 1, now, 4_950, 1),
  );

  const summary = summarizeTokenPool(tokens, tokens, now, 20);

  assert.equal(summary.level, "warning");
  assert.deepEqual(summary.reasons, ["2 of 20 tokens could not be checked"]);
});

test("warns when the pool has only one token with reserve", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_900, 12);
  const summary = summarizeTokenPool([current], [current]);

  assert.equal(summary.level, "warning");
  assert.deepEqual(summary.reasons, [
    "Only one token has more than 4,000 requests left",
  ]);
});

test("marks a pool with no available token critical", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 500, 12);
  const summary = summarizeTokenPool([current], [current]);

  assert.equal(summary.level, "critical");
  assert.equal(summary.availableTokens, 0);
  assert.equal(summary.belowReserveTokens, 1);
  assert.match(summary.reasons.join(" "), /No token has more than/);
});

test("counts locally rate-limited tokens separately from reserve", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_900, 12);
  current.available = false;
  const summary = summarizeTokenPool([current], [current]);

  assert.equal(summary.rateLimitedTokens, 1);
  assert.equal(summary.belowReserveTokens, 0);
  assert.equal(summary.availableTokens, 0);
  assert.equal(summary.level, "critical");
});

test("represents an empty observation run instead of reusing stale state", () => {
  const observedAt = "2026-08-27T13:00:00.000Z";
  const summary = summarizeTokenPool([], [], observedAt);

  assert.equal(summary.level, "critical");
  assert.equal(summary.observedAt, observedAt);
  assert.equal(summary.tokenCount, 0);
});

test("alert decision sends on changes and suppresses unchanged state", () => {
  const now = new Date("2026-08-27T13:00:00.000Z");
  const summary = summarizeTokenPool(
    [observation(1, now.toISOString(), 4_900, 12)],
    [],
  );
  const state: AlertState = {
    level: "warning",
    fingerprint: "same",
    last_sent_at: "2026-08-27T12:00:00.000Z",
  };

  assert.deepEqual(getAlertDecision(state, summary, "changed", now), {
    recovery: false,
    shouldSend: true,
  });
  assert.deepEqual(getAlertDecision(state, summary, "same", now), {
    recovery: false,
    shouldSend: false,
  });
});

test("alert decision repeats after twelve hours", () => {
  const now = new Date("2026-08-27T13:00:00.000Z");
  const summary = summarizeTokenPool(
    [observation(1, now.toISOString(), 4_900, 12)],
    [],
  );
  const state: AlertState = {
    level: "warning",
    fingerprint: "same",
    last_sent_at: "2026-08-27T00:59:59.000Z",
  };

  assert.equal(getAlertDecision(state, summary, "same", now).shouldSend, true);
});

test("alert decision sends recovery after an unhealthy state", () => {
  const now = new Date("2026-08-27T13:00:00.000Z");
  const healthy = summarizeTokenPool(
    [
      observation(1, now.toISOString(), 4_900, 12),
      observation(2, now.toISOString(), 4_800, 12),
    ],
    [],
  );
  const state: AlertState = {
    level: "critical",
    fingerprint: "critical",
    last_sent_at: "2026-08-27T12:00:00.000Z",
  };

  assert.deepEqual(getAlertDecision(state, healthy, "healthy", now), {
    recovery: true,
    shouldSend: true,
  });
});

test("returns the fresh check when the alert email cannot be sent", async () => {
  const inserted: unknown[][] = [];
  const runs: unknown[][] = [];
  const rows = () =>
    inserted.map(
      ([tokenId, userId, userName, observedAt, remaining, limit]) => ({
        token_id: tokenId,
        user_id: userId,
        user_name: userName,
        observed_at: observedAt,
        remaining,
        limit_count: limit,
        reset_at: null,
        usage_count: 0,
        is_available: 0,
        error: null,
      }),
    );
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...bound: unknown[]) => statement(sql, bound),
    all: async () => ({ results: results(sql) }),
    first: async () => null,
    run: async () => ({}),
    sql,
    args,
  });
  const results = (sql: string): unknown[] => {
    if (sql.includes("user_name, token, usage_count")) {
      return [
        {
          id: 1,
          user_id: "u",
          user_name: "u",
          token: "t",
          usage_count: 0,
          rate_limited_at: null,
        },
      ];
    }
    if (sql.includes("SELECT id"))
      return [{ id: 1, user_id: "u", created_at: "2026-08-01T00:00:00.000Z" }];
    if (sql.includes("FROM token_observation_runs")) {
      return runs.map(([observedAt, tokenCount]) => ({
        observed_at: observedAt,
        token_count: tokenCount,
      }));
    }
    if (sql.includes("FROM token_observations o")) return rows();
    return [];
  };
  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: ReturnType<typeof statement>[]) => {
      for (const { sql, args } of statements) {
        if (sql.includes("INSERT INTO token_observation_runs")) runs.push(args);
        if (sql.includes("INSERT INTO token_observations")) inserted.push(args);
      }
      return [];
    },
  };
  const env = {
    DB: db,
    RESEND_API_KEY: "re_test",
    TOKEN_ALERT_TO: "ops@example.com",
    TOKEN_ALERT_FROM: "alerts@example.com",
  } as unknown as Env;

  const realFetch = globalThis.fetch;
  const realConsoleError = console.error;
  console.error = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("api.resend.com")) {
      return new Response("domain is not verified", { status: 403 });
    }
    return Response.json({
      resources: {
        core: { limit: 5_000, remaining: 500, reset: 1_790_000_000 },
      },
    });
  }) as typeof fetch;

  try {
    const data = await observeTokenPool(
      env,
      new Date("2026-10-01T13:00:00.000Z"),
    );

    assert.equal(runs.length, 1, "the snapshot is stored before alerting");
    assert.equal(data.summary.observedAt, "2026-10-01T13:00:00.000Z");
    assert.match(data.alerting.error ?? "", /Resend returned 403/);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realConsoleError;
  }
});
