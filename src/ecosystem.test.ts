import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { getEcosystemInsights, rankMomentum } from "./analytics/ecosystem.js";
test("momentum sorts by absolute gain, filters noise and labels zero baselines", () => {
  const result = rankMomentum([
    { tool: "big", current: 2000, previous: 1000 },
    { tool: "small", current: 110, previous: 1 },
    { tool: "tiny", current: 20, previous: 0 },
    { tool: "new", current: 100, previous: 0 },
    { tool: "gone", current: 0, previous: 100 },
  ]);
  assert.deepEqual(
    result.map((r) => r.tool),
    ["big", "small", "new", "gone"],
  );
  assert.equal(result[2].percent, null);
  assert.equal(result[3].percent, -100);
});
test("ecosystem SQL excludes today, preserves unknown platforms and includes declines", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE platforms(id INTEGER,os TEXT,arch TEXT);CREATE TABLE tools(id INTEGER,name TEXT);CREATE TABLE daily_tool_platform_stats(date TEXT,platform_id INTEGER,downloads INTEGER);CREATE TABLE daily_tool_stats(date TEXT,tool_id INTEGER,downloads INTEGER);INSERT INTO tools VALUES(1,'rising'),(2,'gone');INSERT INTO platforms VALUES(1,'linux','x64');INSERT INTO daily_tool_platform_stats VALUES('2026-09-09',1,100),('2026-09-09',0,20),('2026-09-10',1,999);INSERT INTO daily_tool_stats VALUES('2026-09-09',1,200),('2026-09-01',1,100),('2026-09-01',2,100),('2026-09-10',1,999);`,
  );
  const adapter = {
    prepare(sql: string) {
      return {
        bind(...args: (string | number)[]) {
          return { sql, args };
        },
      };
    },
    async batch(queries: { sql: string; args: (string | number)[] }[]) {
      return queries.map((q) => ({
        results: db.prepare(q.sql).all(...q.args),
      }));
    },
  } as unknown as D1Database;
  try {
    const result = await getEcosystemInsights(
      adapter,
      Date.parse("2026-09-10T18:00:00Z"),
    );
    assert.equal(
      result.platforms.reduce((n, r) => n + r.downloads, 0),
      120,
    );
    assert(result.platforms.some((r) => r.os === "unknown"));
    assert.equal(result.momentum[0].gain, 100);
    assert.equal(result.momentum[1].gain, -100);
    assert.equal(result.momentumCoverage.days, 2);
  } finally {
    db.close();
  }
});
