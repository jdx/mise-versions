// Per-day request counts for mise's own release folders, from Cloudflare
// Logpush `http_requests` records.
//
// mise.jdx.dev and mise.en.dev serve the `mise` R2 bucket, which keeps every
// release under `/v<version>/` (`mise-v<version>-<os>-<arch>[-musl]` binaries
// and archives, plus checksums, signatures and install.sh). jdx/mise prunes
// old release folders that nobody downloads, which needs exact per-version
// counts; refresh-logpush-analytics-direct.js feeds every log line through
// MiseReleaseDayAggregator and writes the result with
// writeMiseReleaseDownloads().
//
// Unlike the mise usage numbers, these count every client (curl, install
// scripts, browsers, mise itself, CI), not only `mise/` user agents.

import {
  isClientRequest,
  parseLogpushObjectWindow,
  recordTimeMs,
  utcDate,
} from "./logpush.js";
import { batchUpsert, queryD1 } from "../refresh-download-rollups-direct.js";

export const MISE_RELEASE_HOSTS = ["mise.jdx.dev", "mise.en.dev"];
export const DEFAULT_MISE_RELEASE_ZONES = ["jdx.dev", "en.dev"];

const RELEASE_PATH = /^\/v(\d{4}\.\d+\.\d+)\/(.+)$/;
const BINARY_FILE =
  /^mise-v(\d{4}\.\d+\.\d+)-[a-z0-9_]+(?:-[a-z0-9_]+)+(?:\.tar\.gz|\.tar\.xz|\.tar\.zst|\.zip|\.exe)?$/;
const COUNTED_METHODS = new Set(["GET", "HEAD"]);

// The longest stretch of a day, at either end or in between, that a zone's
// Logpush object windows may leave uncovered for the day to count as covered.
// Both zones write a batch every minute or so (the largest gap on
// 2026-10-14 was 2 seconds), so a longer hole means the job started late (as
// on 2026-10-14, when the jobs were created at about 14:54 UTC), paused, or
// objects are missing. A lost object shorter than this is not detected.
const MAX_GAP_MS = 15 * 60 * 1000;

// Classify a ClientRequestURI (path plus query). Returns
// { version, kind: "binary" | "other" } for a file under a release folder,
// or null. A binary is the folder's own `mise-v<version>-<os>-<arch>`
// executable or archive; anything else in the folder is `other`.
export function parseMiseReleaseUri(uri) {
  if (typeof uri !== "string") return null;
  const end = uri.search(/[?#]/);
  const path = end === -1 ? uri : uri.slice(0, end);
  const match = RELEASE_PATH.exec(path);
  if (!match) return null;
  const [, version, file] = match;
  const binary = BINARY_FILE.exec(file);
  return {
    version,
    kind: binary && binary[1] === version ? "binary" : "other",
  };
}

export class MiseReleaseDayAggregator {
  constructor({ date, hosts = MISE_RELEASE_HOSTS }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bad date ${date}`);
    this.date = date;
    this.hostList = hosts.map((host) => host.toLowerCase());
    this.hosts = new Set(this.hostList);
    this.versions = new Map();
    this.stats = { requests: 0, binaryRequests: 0, otherRequests: 0 };
  }

  addLine(line) {
    // Cheap prefilter: the host only appears in ClientRequestHost.
    if (!line || !this.hostList.some((host) => line.includes(host))) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return; // the Logpush aggregator already reports malformed lines
    }
    this.addRecord(record);
  }

  addRecord(record) {
    const host = String(record.ClientRequestHost || "").toLowerCase();
    if (!this.hosts.has(host)) return;
    const ms = recordTimeMs(record);
    if (ms === null || utcDate(ms) !== this.date) return;
    if (!isClientRequest(record)) return;
    if (!COUNTED_METHODS.has(record.ClientRequestMethod || "GET")) return;
    if (Number(record.EdgeResponseStatus ?? 200) >= 400) return;
    const release = parseMiseReleaseUri(record.ClientRequestURI);
    if (!release) return;

    let row = this.versions.get(release.version);
    if (!row) {
      row = { version: release.version, binary: 0, other: 0 };
      this.versions.set(release.version, row);
    }
    this.stats.requests++;
    if (release.kind === "binary") {
      row.binary++;
      this.stats.binaryRequests++;
    } else {
      row.other++;
      this.stats.otherRequests++;
    }
  }

  rows() {
    return [...this.versions.values()].sort((a, b) =>
      a.version < b.version ? -1 : a.version > b.version ? 1 : 0,
    );
  }
}

// Whether every zone's Logpush objects cover `date` with no hole longer than
// MAX_GAP_MS: not before the first object, between objects, or after the
// last one. `objects` are the day's listed objects with a `zone` field.
// Returns { complete, zones: { [zone]: { objects, firstStart, lastEnd,
// largestGapSeconds } } }.
export function dayCoverage(objects, zones, date) {
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  const result = { complete: true, zones: {} };
  for (const zone of zones) {
    const zoneObjects = objects.filter((object) => object.zone === zone);
    const windows = zoneObjects
      .map((object) => parseLogpushObjectWindow(object.key))
      .filter(Boolean)
      .sort((a, b) => a.startMs - b.startMs);
    // `reached`: how far into the day the windows so far cover, end to end.
    let reached = dayStart;
    let largestGap = 0;
    for (const window of windows) {
      if (window.startMs >= dayEnd) break;
      largestGap = Math.max(largestGap, window.startMs - reached);
      reached = Math.max(reached, window.endMs);
    }
    largestGap = Math.max(largestGap, dayEnd - reached);
    if (largestGap > MAX_GAP_MS) result.complete = false;
    result.zones[zone] = {
      objects: zoneObjects.length,
      firstStart:
        windows.length === 0
          ? null
          : new Date(windows[0].startMs).toISOString(),
      lastEnd:
        windows.length === 0
          ? null
          : new Date(Math.max(...windows.map((w) => w.endMs))).toISOString(),
      largestGapSeconds: largestGap / 1000,
    };
  }
  return result;
}

// Replace the day's mise_release_daily_downloads rows. A row in
// mise_release_download_days marks the day as covered and is what readers
// key on: it is dropped first and written back last, only when `complete`, so
// a run that fails part way, or a day with partial logs, is never read.
export async function writeMiseReleaseDownloads(
  config,
  date,
  aggregator,
  complete,
  updatedAt,
) {
  await queryD1(
    config,
    "DELETE FROM mise_release_download_days WHERE date = ?",
    [date],
    "mise_release_download_days clear",
  );
  await queryD1(
    config,
    "DELETE FROM mise_release_daily_downloads WHERE date = ?",
    [date],
    "mise_release_daily_downloads clear",
  );
  await batchUpsert(
    config,
    "mise_release_daily_downloads",
    ["date", "version", "binary_requests", "other_requests"],
    aggregator
      .rows()
      .map(({ version, binary, other }) => [date, version, binary, other]),
  );
  if (!complete) return;
  const { binaryRequests, otherRequests } = aggregator.stats;
  await batchUpsert(
    config,
    "mise_release_download_days",
    ["date", "binary_requests", "other_requests", "updated_at"],
    [[date, binaryRequests, otherRequests, updatedAt]],
  );
}
