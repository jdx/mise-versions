#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completedDates,
  dateStrAgo,
  lastCompleteUtcDate,
} from "./rollup-dates.js";

const noon = Date.UTC(2026, 6, 15, 12, 0, 0);

describe("rollup-dates", () => {
  it("treats the current UTC day as incomplete", () => {
    assert.equal(lastCompleteUtcDate(noon), "2026-07-14");
    assert.equal(
      lastCompleteUtcDate(Date.UTC(2026, 6, 15, 0, 0, 1)),
      "2026-07-14",
    );
    assert.equal(
      lastCompleteUtcDate(Date.UTC(2026, 6, 15, 23, 59, 59)),
      "2026-07-14",
    );
  });

  it("refreshes complete days newest first, skipping today", () => {
    assert.deepEqual(completedDates(null, 4, noon), [
      "2026-07-14",
      "2026-07-13",
      "2026-07-12",
      "2026-07-11",
    ]);
    assert.deepEqual(completedDates(null, 1, noon), ["2026-07-14"]);
  });

  it("honors an explicit backfill date", () => {
    assert.deepEqual(completedDates("2026-07-10", 3, noon), [
      "2026-07-10",
      "2026-07-09",
      "2026-07-08",
    ]);
  });

  it("clamps a base date that is not over yet", () => {
    assert.deepEqual(completedDates("2026-07-15", 2, noon), [
      "2026-07-14",
      "2026-07-13",
    ]);
    assert.deepEqual(completedDates("2026-07-20", 2, noon), [
      "2026-07-14",
      "2026-07-13",
    ]);
  });

  it("rejects a date that is not on the calendar", () => {
    assert.throws(
      () => completedDates("2026-99-99", 2, noon),
      /not a calendar date/,
    );
    assert.throws(
      () => completedDates("2026-02-31", 2, noon),
      /not a calendar date/,
    );
  });

  it("crosses month and year boundaries", () => {
    assert.equal(dateStrAgo("2026-03-01", 1), "2026-02-28");
    assert.deepEqual(completedDates(null, 2, Date.UTC(2027, 0, 1, 3, 0, 0)), [
      "2026-12-31",
      "2026-12-30",
    ]);
  });
});
