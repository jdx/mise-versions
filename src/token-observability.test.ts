/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  getAlertDecision,
  selectTokenBatch,
  summarizeTokenPool,
  type AlertState,
  type TokenObservation,
} from "./token-observability.js";

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
    available: remaining >= 1_000,
    error: null,
  };
}

test("summarizes total pool burn instead of averaging token rates", () => {
  const previous = "2026-08-27T12:00:00.000Z";
  const current = "2026-08-27T13:00:00.000Z";
  const recent = [
    observation(1, previous, 4_100, 10),
    observation(2, previous, 3_900, 20),
    observation(1, current, 4_000, 12),
    observation(2, current, 3_800, 23),
  ];

  const summary = summarizeTokenPool(recent.slice(-2), recent);

  assert.equal(summary.level, "healthy");
  assert.equal(summary.quotaBurnPerHour, 200);
  assert.equal(summary.checkoutRatePerHour, 5);
  assert.equal(summary.hoursToReserve, 29);
});

test("ignores short manual-check gaps when calculating burn", () => {
  const previous = "2026-08-27T12:00:00.000Z";
  const current = "2026-08-27T12:01:00.000Z";
  const recent = [
    observation(1, previous, 4_100, 10),
    observation(2, previous, 4_100, 20),
    observation(1, current, 4_000, 12),
    observation(2, current, 4_000, 23),
  ];

  const summary = summarizeTokenPool(recent.slice(-2), recent);

  assert.equal(summary.level, "healthy");
  assert.equal(summary.quotaBurnPerHour, null);
  assert.equal(summary.checkoutRatePerHour, null);
  assert.equal(summary.hoursToReserve, null);
});

test("bridges manual checks when a full rate interval is available", () => {
  const recent = [
    observation(1, "2026-08-27T12:00:00.000Z", 4_100, 10),
    observation(1, "2026-08-27T12:05:00.000Z", 4_050, 11),
    observation(1, "2026-08-27T12:15:00.000Z", 3_950, 13),
  ];

  const summary = summarizeTokenPool(recent.slice(-1), recent);

  assert.equal(summary.quotaBurnPerHour, 600);
  assert.equal(summary.checkoutRatePerHour, 12);
});

test("excludes deleted tokens from current burn rates", () => {
  const previous = "2026-08-27T12:00:00.000Z";
  const current = "2026-08-27T13:00:00.000Z";
  const currentToken = observation(1, current, 4_000, 12);
  const recent = [
    observation(1, previous, 4_100, 10),
    observation(2, previous, 4_500, 20),
    currentToken,
    observation(2, current, 3_500, 30),
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
});

test("warns when the pool has only one token with reserve", () => {
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_000, 12);
  const summary = summarizeTokenPool([current], [current]);

  assert.equal(summary.level, "warning");
  assert.deepEqual(summary.reasons, [
    "Only one token has at least 1,000 requests left",
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
  const current = observation(1, "2026-08-27T13:00:00.000Z", 4_000, 12);
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
    [observation(1, now.toISOString(), 4_000, 12)],
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
    [observation(1, now.toISOString(), 4_000, 12)],
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
      observation(1, now.toISOString(), 4_000, 12),
      observation(2, now.toISOString(), 4_000, 12),
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
