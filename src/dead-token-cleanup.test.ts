/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import { checksLookHealthy } from "./dead-token-cleanup.js";

test("removes nothing when there is no recent data", () => {
  assert.equal(checksLookHealthy({ total: 0, ok: 0 }), false);
});

test("removes nothing during an apparent outage", () => {
  assert.equal(checksLookHealthy({ total: 100, ok: 10 }), false);
  assert.equal(checksLookHealthy({ total: 100, ok: 49 }), false);
});

test("cleans up when most checks succeed", () => {
  assert.equal(checksLookHealthy({ total: 100, ok: 50 }), true);
  assert.equal(checksLookHealthy({ total: 100, ok: 97 }), true);
});
