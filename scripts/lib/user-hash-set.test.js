#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeUserHashes,
  encodeUserHashes,
  mergeSorted,
  unionSize,
} from "./user-hash-set.js";

describe("user-hash-set", () => {
  it("round-trips sorted 48-bit hashes", () => {
    const values = Float64Array.from([0, 1, 0xabcdef, 2 ** 48 - 1]);
    const decoded = decodeUserHashes(encodeUserHashes(values));
    assert.deepEqual([...decoded], [...values]);
    assert.deepEqual([...decodeUserHashes(encodeUserHashes([]))], []);
  });

  it("rejects unsorted or out-of-range input and foreign data", () => {
    assert.throws(() => encodeUserHashes([2, 1]), /sorted/);
    assert.throws(() => encodeUserHashes([1, 1]), /sorted/);
    assert.throws(() => encodeUserHashes([2 ** 48]), /range/);
    assert.throws(() => decodeUserHashes(Buffer.from("nope")));
  });

  it("unions exactly", () => {
    assert.deepEqual(
      [
        ...mergeSorted(
          Float64Array.from([1, 3, 5]),
          Float64Array.from([2, 3, 6]),
        ),
      ],
      [1, 2, 3, 5, 6],
    );
    assert.equal(
      unionSize([
        Float64Array.from([1, 2, 3]),
        Float64Array.from([3, 4]),
        Float64Array.from([]),
        Float64Array.from([1, 9]),
      ]),
      5,
    );
    assert.equal(unionSize([]), 0);
  });
});
