/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RETIRED_PER_RUN,
  MIN_POOL_SIZE_AFTER,
  hasLegacyScopes,
  planSunset,
  type PoolTokenScopes,
} from "./legacy-scope-sunset.js";

function token(
  id: number,
  user: string,
  scopes: string | null,
  createdAt = "2026-01-01T00:00:00.000Z",
): PoolTokenScopes {
  return { id, user_id: user, scopes, created_at: createdAt };
}

function pool(legacy: PoolTokenScopes[], clean: number): PoolTokenScopes[] {
  const rest = Array.from({ length: clean }, (_, i) =>
    token(1000 + i, `clean-${i}`, "[]"),
  );
  return [...legacy, ...rest];
}

test("only tokens with scopes count as legacy", () => {
  assert.equal(hasLegacyScopes('["public_repo"]'), true);
  assert.equal(hasLegacyScopes("[]"), false);
  assert.equal(hasLegacyScopes(null), false);
  assert.equal(hasLegacyScopes("not json"), false);
});

test("does nothing when disabled or the pool is unhealthy", () => {
  const tokens = pool([token(1, "a", '["public_repo"]')], 20);
  assert.deepEqual(planSunset(tokens, { enabled: false, healthy: true }), []);
  assert.deepEqual(planSunset(tokens, { enabled: true, healthy: false }), []);
});

test("retires the oldest legacy users first, a few at a time", () => {
  const tokens = pool(
    [
      token(1, "newer", '["public_repo"]', "2026-03-01T00:00:00.000Z"),
      token(2, "oldest", '["public_repo"]', "2026-01-01T00:00:00.000Z"),
      token(3, "middle", '["public_repo"]', "2026-02-01T00:00:00.000Z"),
    ],
    20,
  );
  const plan = planSunset(tokens, { enabled: true, healthy: true });
  assert.equal(plan.length, MAX_RETIRED_PER_RUN);
  assert.deepEqual(plan, ["oldest", "middle"]);
});

test("never shrinks the pool below the minimum", () => {
  const tokens = pool(
    [token(1, "a", '["public_repo"]'), token(2, "b", '["public_repo"]')],
    MIN_POOL_SIZE_AFTER - 1,
  );
  // 2 legacy + 9 clean = 11; retiring one leaves 10, retiring two leaves 9.
  assert.deepEqual(planSunset(tokens, { enabled: true, healthy: true }), ["a"]);
  assert.deepEqual(
    planSunset(
      pool([token(1, "a", '["public_repo"]')], MIN_POOL_SIZE_AFTER - 1),
      {
        enabled: true,
        healthy: true,
      },
    ),
    [],
  );
});

test("counts every row of a user with several sign-ins", () => {
  const tokens = pool(
    [
      token(1, "a", '["public_repo"]'),
      token(2, "a", '["public_repo"]'),
      token(3, "a", '["public_repo"]'),
    ],
    MIN_POOL_SIZE_AFTER,
  );
  // Retiring "a" removes 3 rows, which would leave 10 clean: allowed.
  assert.deepEqual(planSunset(tokens, { enabled: true, healthy: true }), ["a"]);
  assert.deepEqual(
    planSunset(tokens.slice(0, -1), { enabled: true, healthy: true }),
    [],
  );
});
