/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
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
  // 100 tokens checked 45 at a time: every run observes only part of the pool.
  const runs = [
    { observed_at: "2026-08-27T12:00:00.000Z", token_count: 100 },
    { observed_at: "2026-08-27T12:15:00.000Z", token_count: 100 },
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
  // Token 1 carries over from the previous run; token 2 is replaced by its newer reading.
  assert.equal(points[1].remaining, 13_000);
  assert.equal(points[1].limit, 15_000);
  assert.deepEqual(historyPoints(runs, []), []);
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
): TokenObservation {
  return {
    tokenId,
    userId: `user-${tokenId}`,
    userName: null,
    observedAt,
    remaining,
    limit: 5_000,
    resetAt: "2026-08-27T13:30:00.000Z",
    usageCount,
    available: remaining > 4_000,
    error: null,
  };
}

test("summarizes total pool burn instead of averaging token rates", () => {
  const previous = "2026-08-27T12:00:00.000Z";
  const current = "2026-08-27T13:00:00.000Z";
  const recent = [
    observation(1, previous, 4_900, 10),
    observation(2, previous, 4_700, 20),
    observation(1, current, 4_800, 12),
    observation(2, current, 4_600, 23),
  ];

  const summary = summarizeTokenPool(recent.slice(-2), recent);

  assert.equal(summary.level, "healthy");
  assert.equal(summary.quotaBurnPerHour, 200);
  assert.equal(summary.checkoutRatePerHour, 5);
  assert.equal(summary.hoursToReserve, 7);
});

test("ignores short manual-check gaps when calculating burn", () => {
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
  assert.equal(summary.quotaBurnPerHour, null);
  assert.equal(summary.checkoutRatePerHour, null);
  assert.equal(summary.hoursToReserve, null);
});

test("bridges manual checks when a full rate interval is available", () => {
  const recent = [
    observation(1, "2026-08-27T12:00:00.000Z", 4_900, 10),
    observation(1, "2026-08-27T12:05:00.000Z", 4_850, 11),
    observation(1, "2026-08-27T12:15:00.000Z", 4_750, 13),
  ];

  const summary = summarizeTokenPool(recent.slice(-1), recent);

  assert.equal(summary.quotaBurnPerHour, 600);
  assert.equal(summary.checkoutRatePerHour, 12);
});

test("excludes deleted tokens from current burn rates", () => {
  const previous = "2026-08-27T12:00:00.000Z";
  const current = "2026-08-27T13:00:00.000Z";
  const currentToken = observation(1, current, 4_800, 12);
  const recent = [
    observation(1, previous, 4_900, 10),
    observation(2, previous, 4_950, 20),
    currentToken,
    observation(2, current, 4_500, 30),
  ];

  const summary = summarizeTokenPool([currentToken], recent);

  assert.equal(summary.quotaBurnPerHour, 100);
  assert.equal(summary.checkoutRatePerHour, 2);
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
  assert.match(summary.reasons.join(" "), /59 tokens were deferred/);
  assert.equal(shouldEvaluateAlert(summary), true);
});

test("defers alert decisions only when partial data has no concrete issue", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_900, 12);
  const summary = summarizeTokenPool(
    [current],
    [current],
    current.observedAt,
    60,
  );

  assert.equal(shouldEvaluateAlert(summary), false);
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
  assert.match(summary.reasons.join(" "), /below reserve/);
});

test("marks locally rate-limited tokens separately from reserve", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_900, 12);
  current.available = false;
  const summary = summarizeTokenPool([current], [current]);

  assert.equal(summary.rateLimitedTokens, 1);
  assert.equal(summary.belowReserveTokens, 0);
  assert.match(summary.reasons.join(" "), /marked rate-limited/);
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
    if (sql.includes("SELECT id")) return [{ id: 1 }];
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
