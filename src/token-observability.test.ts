/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeTokenPool,
  type TokenObservation,
} from "./token-observability.js";

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
});
