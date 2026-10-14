// Compact, exact per-day sets of user hashes for trailing-window MAU.
//
// Each user is the 48-bit integer value of a 12-hex-char IP hash. A day's set
// is stored sorted as fixed-width 6-byte big-endian values behind a small
// header, gzip'd: ~6 MB raw for 10^6 users, so a 30-day window is a few
// hundred MB of reads at most, and the union is an exact merge of sorted
// arrays. HyperLogLog would be smaller but approximate (~1-2% error), which
// would blur the comparison against the current exact Analytics Engine
// count(DISTINCT) numbers.

import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = "MUH1";
const HEADER_BYTES = 8;
const VALUE_BYTES = 6;
const MAX_VALUE = 2 ** 48;

function assertSorted(values) {
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isInteger(value) || value < 0 || value >= MAX_VALUE) {
      throw new Error(`User hash out of range: ${value}`);
    }
    if (i > 0 && value <= values[i - 1]) {
      throw new Error("User hashes must be sorted and distinct");
    }
  }
}

export function encodeUserHashes(sortedValues) {
  assertSorted(sortedValues);
  const buffer = Buffer.alloc(HEADER_BYTES + sortedValues.length * VALUE_BYTES);
  buffer.write(MAGIC, 0, "ascii");
  buffer.writeUInt32BE(sortedValues.length, 4);
  for (let i = 0; i < sortedValues.length; i++) {
    buffer.writeUIntBE(
      sortedValues[i],
      HEADER_BYTES + i * VALUE_BYTES,
      VALUE_BYTES,
    );
  }
  return gzipSync(buffer, { level: 9 });
}

export function decodeUserHashes(gzipped) {
  const buffer = gunzipSync(gzipped);
  if (buffer.toString("ascii", 0, 4) !== MAGIC) {
    throw new Error("Not a user hash set");
  }
  const count = buffer.readUInt32BE(4);
  if (buffer.length !== HEADER_BYTES + count * VALUE_BYTES) {
    throw new Error("Truncated user hash set");
  }
  const values = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    values[i] = buffer.readUIntBE(HEADER_BYTES + i * VALUE_BYTES, VALUE_BYTES);
  }
  return values;
}

// Union of two sorted, distinct arrays.
export function mergeSorted(a, b) {
  const out = new Float64Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < a.length && j < b.length) {
    if (a[i] < b[j]) out[n++] = a[i++];
    else if (a[i] > b[j]) out[n++] = b[j++];
    else {
      out[n++] = a[i++];
      j++;
    }
  }
  while (i < a.length) out[n++] = a[i++];
  while (j < b.length) out[n++] = b[j++];
  return out.subarray(0, n);
}

export function unionSize(sets) {
  let union = new Float64Array(0);
  for (const set of sets) union = mergeSorted(union, set);
  return union.length;
}
