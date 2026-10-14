// Parsing, filtering, and per-day aggregation of Cloudflare Logpush
// `http_requests` records for mise usage analytics.
//
// Every request to the jdx.dev zone, static asset or Worker, lands in the log,
// so these helpers count mise clients that never invoke the Worker. The
// semantics deliberately match the Analytics Engine rollups in
// refresh-mau-direct.js and refresh-download-rollups-direct.js so the two can
// be compared side by side:
//
// - users are identified by the same 12-hex-char HMAC-SHA256 of the client IP
//   that web/src/lib/hash.ts writes to Analytics Engine `index1`, keyed by the
//   Worker's API_SECRET;
// - CI clients are excluded from users and downloads;
// - downloads are deduplicated per (user, tool, version) per UTC day, keeping
//   the os/arch/backend of the newest request.

import { createHmac } from "node:crypto";

export const BEACON_PATH = "/t";
export const DEFAULT_BEACON_HOSTS = [
  "mise-versions.jdx.dev",
  "mise-tools.jdx.dev",
];

// Beacon fields are client supplied; anything longer is junk, not a tool.
const MAX_BEACON_FIELD_LENGTH = 256;

// `mise/2026.10.10 linux-x64 (2026-10-11) bash`, with a trailing ` ci` token
// on CI from mise releases after 2026.10.10. Older clients have no CI marker
// and are counted as non-CI.
const MISE_USER_AGENT = /^mise\/(\S+)/;

export function parseMiseUserAgent(userAgent) {
  if (typeof userAgent !== "string") return null;
  const match = MISE_USER_AGENT.exec(userAgent);
  if (!match) return null;
  return {
    version: match[1],
    ci: /\sci$/.test(userAgent.trimEnd()),
  };
}

// Logpush marks subrequests a Worker makes to the zone; only eyeball traffic
// is a client. Older jobs may omit ClientRequestSource.
export function isClientRequest(record) {
  if (record.WorkerSubrequest === true) return false;
  const source = record.ClientRequestSource;
  return source === undefined || source === null || source === "eyeball";
}

// EdgeStartTimestamp is RFC3339 when the job uses timestamp_format=rfc3339,
// otherwise unix seconds or nanoseconds. Returns epoch milliseconds.
export function recordTimeMs(record) {
  const value = record.EdgeStartTimestamp;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) return numericTimestampMs(Number(value));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === "number") return numericTimestampMs(value);
  return null;
}

function numericTimestampMs(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > 1e17) return Math.floor(value / 1e6); // nanoseconds
  if (value > 1e14) return Math.floor(value / 1e3); // microseconds
  if (value > 1e11) return value; // milliseconds
  return value * 1000; // seconds
}

export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Same digest as hashIP() in web/src/lib/hash.ts, so Logpush users line up
// with the Analytics Engine `index1` values written by the Worker.
export function hashIp(ip, secret) {
  return createHmac("sha256", secret).update(ip).digest("hex").slice(0, 12);
}

export function backendType(full) {
  return (full && full.split(":")[0]) || "unknown";
}

function cleanBeaconField(value) {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_BEACON_FIELD_LENGTH) return null;
  // Control characters never appear in tool names, versions, or platforms.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

// Parse `/t?tool=<tool>&full=<backend>&version=<v>&os=<os>&arch=<arch>`
// from ClientRequestURI (path plus query). Returns null for anything that is
// not a well-formed beacon; tool and version are required, like the
// /api/tools/<tool> POST body.
export function parseBeaconUri(uri) {
  if (typeof uri !== "string") return null;
  const queryStart = uri.indexOf("?");
  const path = queryStart === -1 ? uri : uri.slice(0, queryStart);
  if (path !== BEACON_PATH) return null;
  if (queryStart === -1) return null;

  let params;
  try {
    params = new URLSearchParams(uri.slice(queryStart + 1));
  } catch {
    return null;
  }
  const tool = cleanBeaconField(params.get("tool"));
  const version = cleanBeaconField(params.get("version"));
  if (!tool || !version) return null;
  return {
    tool,
    version,
    full: cleanBeaconField(params.get("full")),
    os: cleanBeaconField(params.get("os")),
    arch: cleanBeaconField(params.get("arch")),
  };
}

// Logpush names objects `<start>_<end>_<hash>.log.gz`, e.g.
// `20261013T235500Z_20261014T000000Z_0123abcd.log.gz`, under a {DATE}
// folder. Returns the covered window in epoch ms, or null if the name does
// not follow that layout.
export function parseLogpushObjectWindow(key) {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const match =
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/.exec(
      name,
    );
  if (!match) return null;
  const toMs = (parts) =>
    Date.UTC(
      Number(parts[0]),
      Number(parts[1]) - 1,
      Number(parts[2]),
      Number(parts[3]),
      Number(parts[4]),
      Number(parts[5]),
    );
  return {
    startMs: toMs(match.slice(1, 7)),
    endMs: toMs(match.slice(7, 13)),
  };
}

function compactDate(date) {
  return date.replaceAll("-", "");
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

// Logpush files a batch under the {DATE} of its start, so requests from the
// end of a day can sit in an object in that day's folder whose window
// crosses midnight, or (for late batches) in the next day's folder. List the
// neighbouring folders too and keep every object whose window overlaps the
// day; records are filtered by their own timestamp afterwards.
export function logpushDayPrefixes(prefix, zone, date) {
  return [-1, 0, 1].map((offset) => ({
    folderDate: shiftDate(date, offset),
    prefix: `${prefix}/${zone}/${compactDate(shiftDate(date, offset))}/`,
  }));
}

// Margin for batches whose name window is slightly narrower than the
// timestamps inside them.
const OBJECT_WINDOW_SLACK_MS = 15 * 60 * 1000;

export function objectOverlapsDate(key, folderDate, date) {
  const window = parseLogpushObjectWindow(key);
  if (!window) return folderDate === date;
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  return (
    window.startMs < dayEnd + OBJECT_WINDOW_SLACK_MS &&
    window.endMs >= dayStart - OBJECT_WINDOW_SLACK_MS
  );
}

// Aggregates one UTC day of Logpush records. Feed it raw NDJSON lines with
// addLine() (cheap prefilter, then JSON) or parsed records with addRecord().
export class LogpushDayAggregator {
  constructor({
    date,
    secret,
    hosts = null,
    beaconHosts = DEFAULT_BEACON_HOSTS,
  }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bad date ${date}`);
    if (!secret) throw new Error("An IP hash secret is required");
    this.date = date;
    this.secret = secret;
    this.hosts = hosts ? new Set(hosts.map((h) => h.toLowerCase())) : null;
    this.beaconHosts = new Set(beaconHosts.map((h) => h.toLowerCase()));
    this.users = new Set();
    this.downloads = new Map();
    this.hashCache = new Map();
    this.stats = {
      lines: 0,
      malformed: 0,
      // mise client requests on this UTC day, CI included
      inDay: 0,
      miseRequests: 0,
      ciRequests: 0,
      beaconRequests: 0,
      ciBeaconRequests: 0,
      firstEventMs: null,
      lastEventMs: null,
    };
  }

  addLine(line) {
    if (!line) return;
    this.stats.lines++;
    // Only mise clients matter, and their user agent always appears in the
    // line as `"mise/`; skipping JSON.parse for everything else keeps a ~30M
    // line day fast.
    if (!line.includes('"mise/')) return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      this.stats.malformed++;
      return;
    }
    this.addRecord(record);
  }

  hash(ip) {
    let hashed = this.hashCache.get(ip);
    if (hashed === undefined) {
      hashed = hashIp(ip, this.secret);
      this.hashCache.set(ip, hashed);
    }
    return hashed;
  }

  addRecord(record) {
    const ms = recordTimeMs(record);
    if (ms === null || utcDate(ms) !== this.date) return;
    if (!isClientRequest(record)) return;

    const host = String(record.ClientRequestHost || "").toLowerCase();
    if (this.hosts && !this.hosts.has(host)) return;

    const client = parseMiseUserAgent(record.ClientRequestUserAgent);
    if (!client) return;
    if (!record.ClientIP) return;

    this.stats.inDay++;
    if (this.stats.firstEventMs === null || ms < this.stats.firstEventMs) {
      this.stats.firstEventMs = ms;
    }
    if (this.stats.lastEventMs === null || ms > this.stats.lastEventMs) {
      this.stats.lastEventMs = ms;
    }

    const beacon =
      this.beaconHosts.has(host) &&
      (record.ClientRequestMethod || "GET") === "GET" &&
      Number(record.EdgeResponseStatus ?? 200) < 400
        ? parseBeaconUri(record.ClientRequestURI)
        : null;

    if (client.ci) {
      this.stats.ciRequests++;
      if (beacon) this.stats.ciBeaconRequests++;
      return;
    }

    this.stats.miseRequests++;
    const ipHash = this.hash(record.ClientIP);
    this.users.add(parseInt(ipHash, 16));

    if (!beacon) return;
    this.stats.beaconRequests++;
    const key = `${ipHash}\0${beacon.tool}\0${beacon.version}`;
    const existing = this.downloads.get(key);
    if (!existing || ms >= existing.ms) {
      this.downloads.set(key, {
        ms,
        ipHash,
        tool: beacon.tool,
        version: beacon.version,
        os: beacon.os,
        arch: beacon.arch,
        backendType: backendType(beacon.full),
      });
    }
  }

  // Sorted numeric user hashes (48-bit integers, exact in a double).
  userHashes() {
    return Float64Array.from(this.users).sort();
  }

  // Download rollups shaped like refresh-download-rollups-direct.js's
  // Analytics Engine query results.
  downloadRollups() {
    const totalUsers = new Set();
    const tools = new Map();
    const backends = new Map();
    const toolBackends = new Map();
    const versions = new Map();
    const platforms = new Map();

    const bump = (map, key, init) => {
      let row = map.get(key);
      if (!row) {
        row = { ...init, downloads: 0 };
        map.set(key, row);
      }
      row.downloads++;
      return row;
    };

    for (const download of this.downloads.values()) {
      totalUsers.add(download.ipHash);
      const tool = bump(tools, download.tool, {
        tool: download.tool,
        users: new Set(),
      });
      tool.users.add(download.ipHash);
      const backend = bump(backends, download.backendType, {
        backend_type: download.backendType,
        users: new Set(),
      });
      backend.users.add(download.ipHash);
      bump(toolBackends, `${download.tool}\0${download.backendType}`, {
        tool: download.tool,
        backend_type: download.backendType,
      });
      bump(versions, `${download.tool}\0${download.version}`, {
        tool: download.tool,
        version: download.version,
      });
      bump(
        platforms,
        `${download.tool}\0${download.os ?? ""}\0${download.arch ?? ""}`,
        {
          tool: download.tool,
          os: download.os ?? "",
          arch: download.arch ?? "",
        },
      );
    }

    const withUsers = (rows) =>
      [...rows.values()].map(({ users, ...row }) => ({
        ...row,
        unique_users: users.size,
      }));

    return {
      total: this.downloads.size,
      uniqueUsers: totalUsers.size,
      tools: withUsers(tools),
      backends: withUsers(backends),
      toolBackends: [...toolBackends.values()],
      versions: [...versions.values()],
      platforms: [...platforms.values()],
    };
  }
}
