import assert from "node:assert/strict";
import test from "node:test";
import { isFreshOAuthState, newOAuthState } from "./auth.js";

test("a normal sign-in state is not marked fresh", () => {
  assert.equal(isFreshOAuthState(newOAuthState(false)), false);
});

test("the second pass of a scope replacement is marked fresh", () => {
  assert.equal(isFreshOAuthState(newOAuthState(true)), true);
});

test("states are unique", () => {
  assert.notEqual(newOAuthState(false), newOAuthState(false));
});
