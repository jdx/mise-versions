#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareLookups, spearman } from "./compare-tool-lookups.js";

describe("spearman", () => {
  it("is 1 for the same order, -1 reversed, and handles ties", () => {
    assert.equal(spearman([3, 2, 1], [30, 20, 10]), 1);
    assert.equal(spearman([3, 2, 1], [10, 20, 30]), -1);
    assert.ok(Math.abs(spearman([3, 2, 2, 1], [4, 3, 2, 1]) - 0.9487) < 1e-3);
    assert.equal(spearman([1], [1]), null);
    assert.equal(spearman([1, 1], [2, 3]), null);
  });
});

describe("compareLookups", () => {
  it("compares the top tools by installs, per day", () => {
    const report = compareLookups({
      installs: [
        { tool: "node", users: 200 },
        { tool: "jq", users: 20 },
        { tool: "uv", users: 100 },
        { tool: "rare", users: 1 },
      ],
      lookups: [
        { tool: "node", users: 600 },
        { tool: "uv", users: 250 },
        { tool: "lookup-only", users: 9999 },
      ],
      days: 2,
      top: 3,
    });
    assert.equal(report.tools, 3);
    assert.deepEqual(
      report.rows.map((row) => [
        row.tool,
        row.installsPerDay,
        row.lookupsPerDay,
        row.ratio,
      ]),
      [
        ["node", 100, 300, 3],
        ["uv", 50, 125, 2.5],
        ["jq", 10, 0, 0],
      ],
    );
    assert.equal(report.spearman, 1);
  });
});
