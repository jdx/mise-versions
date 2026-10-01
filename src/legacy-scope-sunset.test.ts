/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  LEGACY_CAP,
  MAX_RETIRED_PER_RUN,
  buildGrowth,
  computeBurndown,
  hasLegacyScopes,
  planSunset,
  runLegacyScopeSunset,
  type SunsetDeps,
  type PoolTokenScopes,
} from "./legacy-scope-sunset.js";

const LEGACY = '["public_repo"]';
const on = { healthy: true };

function rows(
  count: number,
  prefix: string,
  scopes: string,
  createdAt = "2026-01-01T00:00:00.000Z",
): PoolTokenScopes[] {
  return Array.from({ length: count }, (_, i) => ({
    id: Math.floor(Math.random() * 1e9),
    user_id: `${prefix}-${i}`,
    scopes,
    created_at: createdAt,
  }));
}

test("only tokens with scopes count as legacy", () => {
  assert.equal(hasLegacyScopes(LEGACY), true);
  assert.equal(hasLegacyScopes("[]"), false);
  assert.equal(hasLegacyScopes(null), false);
  assert.equal(hasLegacyScopes("not json"), false);
});

test("does nothing when the pool is unhealthy", () => {
  const tokens = rows(LEGACY_CAP + 50, "old", LEGACY);
  assert.deepEqual(planSunset(tokens, { healthy: false }), []);
});

test("leaves legacy tokens alone while they are within the cap", () => {
  assert.deepEqual(planSunset(rows(LEGACY_CAP, "old", LEGACY), on), []);
});

test("initially trims the legacy excess over the cap, oldest first", () => {
  const tokens = [
    ...rows(LEGACY_CAP - 1, "old", LEGACY, "2026-02-01T00:00:00.000Z"),
    {
      id: 1,
      user_id: "oldest",
      scopes: LEGACY,
      created_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: 2,
      user_id: "newest",
      scopes: LEGACY,
      created_at: "2026-03-01T00:00:00.000Z",
    },
  ];
  // 1001 legacy rows, cap 1000: retire exactly one, the oldest.
  assert.deepEqual(planSunset(tokens, on), ["oldest"]);
});

test("each new no-scope token displaces one legacy token", () => {
  const tokens = [...rows(LEGACY_CAP, "old", LEGACY), ...rows(3, "new", "[]")];
  // 3 clean rows -> only 997 legacy allowed -> retire 3.
  assert.equal(planSunset(tokens, on).length, 3);
});

test("retires at most MAX_RETIRED_PER_RUN users per run", () => {
  const tokens = [
    ...rows(LEGACY_CAP, "old", LEGACY),
    ...rows(MAX_RETIRED_PER_RUN + 40, "new", "[]"),
  ];
  assert.equal(planSunset(tokens, on).length, MAX_RETIRED_PER_RUN);
});

test("never revokes a user who also holds a no-scope token", () => {
  const tokens = [
    {
      id: 1,
      user_id: "mixed",
      scopes: LEGACY,
      created_at: "2025-01-01T00:00:00.000Z",
    },
    {
      id: 2,
      user_id: "mixed",
      scopes: "[]",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    ...rows(LEGACY_CAP, "old", LEGACY),
  ];
  assert.ok(!planSunset(tokens, on).includes("mixed"));
});

test("counts every row of a user with several sign-ins", () => {
  const tokens = [
    ...["a", "a", "a"].map((u, i) => ({
      id: i,
      user_id: u,
      scopes: LEGACY,
      created_at: "2025-01-01T00:00:00.000Z",
    })),
    ...rows(LEGACY_CAP - 1, "old", LEGACY),
  ];
  // 1002 legacy rows: retiring "a" removes 3 rows, which clears the excess.
  assert.deepEqual(planSunset(tokens, on), ["a"]);
});

test("burndown counts legacy and new rows against the cap", () => {
  const tokens = [
    ...rows(LEGACY_CAP + 20, "old", LEGACY),
    ...rows(5, "new", "[]"),
  ];
  const burndown = computeBurndown(tokens);
  assert.equal(burndown.legacyRows, LEGACY_CAP + 20);
  assert.equal(burndown.cleanRows, 5);
  assert.equal(burndown.legacyUsers, LEGACY_CAP + 20);
  assert.equal(burndown.allowedLegacy, LEGACY_CAP - 5);
  assert.equal(burndown.excess, 25);
});

test("burndown excess is zero once legacy fits the allowance", () => {
  assert.equal(computeBurndown(rows(10, "old", LEGACY)).excess, 0);
  assert.equal(computeBurndown(rows(3, "new", "[]"), 2).allowedLegacy, 0);
});

test("never retires more rows than the availability budget allows", () => {
  const tokens = rows(LEGACY_CAP + 10, "old", LEGACY);
  // 10 over the cap, but only 4 rows of headroom above the availability floor.
  assert.equal(planSunset(tokens, { ...on, maxRows: 4 }).length, 4);
  assert.deepEqual(planSunset(tokens, { ...on, maxRows: 0 }), []);
  assert.deepEqual(planSunset(tokens, { ...on, maxRows: -5 }), []);
});

test("growth is rebuilt from join dates before any snapshot exists", () => {
  const pool: PoolTokenScopes[] = [
    {
      id: 1,
      user_id: "a",
      scopes: LEGACY,
      created_at: "2026-09-28T10:00:00.000Z",
    },
    {
      id: 2,
      user_id: "b",
      scopes: LEGACY,
      created_at: "2026-09-29T10:00:00.000Z",
    },
    {
      id: 3,
      user_id: "c",
      scopes: "[]",
      created_at: "2026-09-30T10:00:00.000Z",
    },
  ];
  const points = buildGrowth(pool, [], new Date("2026-09-30T12:00:00.000Z"));
  assert.deepEqual(
    points.map((p) => [p.day, p.legacy, p.clean]),
    [
      ["2026-09-28", 1, 0],
      ["2026-09-29", 2, 0],
      ["2026-09-30", 2, 1],
    ],
  );
});

test("growth switches to real snapshots once they exist", () => {
  const pool: PoolTokenScopes[] = [
    {
      id: 1,
      user_id: "a",
      scopes: LEGACY,
      created_at: "2026-09-28T10:00:00.000Z",
    },
  ];
  const points = buildGrowth(
    pool,
    [
      {
        observed_at: "2026-09-29T04:23:00.000Z",
        legacy_rows: 7,
        clean_rows: 2,
      },
    ],
    new Date("2026-10-01T12:00:00.000Z"),
  );
  assert.deepEqual(
    points.map((p) => [p.day, p.legacy, p.clean]),
    [
      ["2026-09-28", 1, 0],
      ["2026-09-29", 7, 2],
      ["2026-09-30", 7, 2],
      ["2026-10-01", 7, 2],
    ],
  );
});

test("growth keeps recorded history after the pool turns over", () => {
  // Every current row is newer than the oldest stored snapshot.
  const pool: PoolTokenScopes[] = [
    {
      id: 1,
      user_id: "a",
      scopes: "[]",
      created_at: "2026-09-30T10:00:00.000Z",
    },
  ];
  const points = buildGrowth(
    pool,
    [
      {
        observed_at: "2026-09-27T04:23:00.000Z",
        legacy_rows: 5,
        clean_rows: 0,
      },
    ],
    new Date("2026-09-30T12:00:00.000Z"),
  );
  assert.equal(points[0].day, "2026-09-27");
  assert.deepEqual([points[0].legacy, points[0].clean], [5, 0]);
});

function runDeps(
  pool: (PoolTokenScopes & { token: string })[],
  overrides: Partial<SunsetDeps> & {
    availableTokens?: number;
    level?: string;
  } = {},
) {
  const calls = {
    revoked: [] as string[],
    retired: [] as string[],
    snapshots: [] as unknown[],
  };
  const deps: SunsetDeps = {
    getSummary: async () => ({
      level: overrides.level ?? "healthy",
      availableTokens: overrides.availableTokens ?? 1_000,
    }),
    getPool: async () => pool,
    revoke: async (token) => {
      calls.revoked.push(token);
      return true;
    },
    retireUserTokens: async (userId) => {
      calls.retired.push(userId);
    },
    recordSnapshot: async (details) => {
      calls.snapshots.push(details);
    },
    ...overrides,
  };
  return { deps, calls };
}

const withTokens = (pool: PoolTokenScopes[]) =>
  pool.map((row) => ({ ...row, token: `tok-${row.user_id}` }));

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { info, warn, error } = console;
  console.info = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { info, warn, error });
  }
}

test("run revokes and retires the excess when the pool is healthy", async () => {
  const pool = withTokens([...rows(LEGACY_CAP + 2, "old", LEGACY)]);
  const { deps, calls } = runDeps(pool);
  await quietly(() => runLegacyScopeSunset({} as Env, deps));
  assert.equal(calls.retired.length, 2);
  assert.equal(calls.revoked.length, 2);
  assert.deepEqual(calls.snapshots, [{ healthy: true, retiredThisRun: 2 }]);
});

test("run skips and still records a snapshot when the pool is critical", async () => {
  const pool = withTokens(rows(LEGACY_CAP + 2, "old", LEGACY));
  const { deps, calls } = runDeps(pool, { level: "critical" });
  await quietly(() => runLegacyScopeSunset({} as Env, deps));
  assert.deepEqual(calls.revoked, []);
  assert.deepEqual(calls.retired, []);
  assert.deepEqual(calls.snapshots, [{ healthy: false, retiredThisRun: 0 }]);
});

test("run skips when too few tokens are available", async () => {
  const pool = withTokens(rows(LEGACY_CAP + 2, "old", LEGACY));
  const { deps, calls } = runDeps(pool, { availableTokens: 10 });
  await quietly(() => runLegacyScopeSunset({} as Env, deps));
  assert.deepEqual(calls.revoked, []);
  assert.deepEqual(calls.snapshots, [{ healthy: false, retiredThisRun: 0 }]);
});

test("run keeps a user's tokens when GitHub does not confirm the revoke", async () => {
  const pool = withTokens(rows(LEGACY_CAP + 2, "old", LEGACY));
  const { deps, calls } = runDeps(pool, { revoke: async () => false });
  await quietly(() => runLegacyScopeSunset({} as Env, deps));
  assert.deepEqual(calls.retired, []);
  assert.deepEqual(calls.snapshots, [{ healthy: true, retiredThisRun: 0 }]);
});

test("run does nothing while legacy tokens are within the cap", async () => {
  const pool = withTokens(rows(LEGACY_CAP, "old", LEGACY));
  const { deps, calls } = runDeps(pool);
  await quietly(() => runLegacyScopeSunset({} as Env, deps));
  assert.deepEqual(calls.revoked, []);
  assert.deepEqual(calls.snapshots, [{ healthy: true, retiredThisRun: 0 }]);
});
