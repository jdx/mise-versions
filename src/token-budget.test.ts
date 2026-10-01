/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  EMERGENCY_MIN_REMAINING,
  MIN_REMAINING,
  hasBudget,
  hasEmergencyBudget,
} from "./token-budget.js";

test("leaves tokens alone at or below the normal floor", () => {
  assert.equal(hasBudget(5_000), true);
  assert.equal(hasBudget(MIN_REMAINING + 1), true);
  assert.equal(hasBudget(MIN_REMAINING), false);
  assert.equal(hasBudget(0), false);
});

test("emergency use still keeps a hard minimum", () => {
  assert.equal(hasEmergencyBudget(MIN_REMAINING), true);
  assert.equal(hasEmergencyBudget(EMERGENCY_MIN_REMAINING + 1), true);
  assert.equal(hasEmergencyBudget(EMERGENCY_MIN_REMAINING), false);
  assert.ok(EMERGENCY_MIN_REMAINING < MIN_REMAINING);
});
