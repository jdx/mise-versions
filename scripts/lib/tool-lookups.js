// Tool usage from the requests mise already makes to look tools up, with no
// install beacon: per UTC day, the distinct non-CI machines (IP hashes) that
// fetched anything naming a tool from mise-versions or mise-java.
//
// A lookup is not an install: mise skips it when a lockfile or an exact
// version needs no listing, or the version list it cached in the last hour
// (fetch_remote_versions_cache) is still fresh, and makes one for
// `ls-remote`, `outdated` and `upgrade` checks that install nothing. Counted
// per machine and day, it still follows a tool's popularity, without a
// request whose only purpose is to report an install.
//
// Paths that name a tool (GET, status < 400):
//   mise-versions.jdx.dev, mise-tools.jdx.dev
//     /data/<tool>.toml                version list for a registry tool
//     /tools/<tool>.toml               the same, from older mise releases
//     /data/github/<owner>/<repo>/...  baked GitHub version lists
//     /api/github/repos/<owner>/<repo>/...  the GitHub mirror
//   mise-java.jdx.dev                  java
// GitHub paths are credited to every registry tool with a backend on that
// repo (see registryRepoTools); a repo no registry tool uses is not counted.

export const LOOKUP_HOSTS = ["mise-versions.jdx.dev", "mise-tools.jdx.dev"];
export const JAVA_HOST = "mise-java.jdx.dev";

// The first mise release that sends the `/t` install beacon. Lookups from
// these clients are also counted on their own, to compare with the beacon.
export const BEACON_MIN_MISE_VERSION = [2026, 10, 11];

const MAX_TOOL_LENGTH = 256;
const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const GITHUB_BACKEND = /^(?:aqua|github|ubi):([^/\s[]+)\/([^/\s[]+)/;

/**
 * `owner/repo` (lowercase) to the registry tools with a backend on it, from
 * `mise registry` output (`<tool> <backend> [<backend>...]` per line).
 */
export function registryRepoTools(registryText) {
  const repos = new Map();
  for (const line of String(registryText || "").split("\n")) {
    const [tool, ...backends] = line.trim().split(/\s+/);
    if (!tool || backends.length === 0) continue;
    for (const backend of backends) {
      const match = GITHUB_BACKEND.exec(backend);
      if (!match) continue;
      const repo = `${match[1]}/${match[2]}`.toLowerCase();
      const tools = repos.get(repo) ?? [];
      if (!tools.includes(tool)) tools.push(tool);
      repos.set(repo, tools);
    }
  }
  return repos;
}

function decodeTool(value) {
  let tool;
  try {
    tool = decodeURIComponent(value);
  } catch {
    return null;
  }
  return tool && tool.length <= MAX_TOOL_LENGTH && !tool.includes("/")
    ? tool
    : null;
}

/**
 * The tools a request names, or an empty list. `path` excludes the query.
 */
export function lookupTools(host, path, repoTools) {
  if (host === JAVA_HOST) return ["java"];
  if (!LOOKUP_HOSTS.includes(host)) return [];
  for (const prefix of ["/data/", "/tools/"]) {
    if (path.startsWith(prefix) && path.endsWith(".toml")) {
      const tool = decodeTool(path.slice(prefix.length, -".toml".length));
      return tool ? [tool] : [];
    }
  }
  for (const prefix of ["/data/github/", "/api/github/repos/"]) {
    if (!path.startsWith(prefix)) continue;
    const [owner, repo] = path.slice(prefix.length).split("/");
    if (!owner || !repo || !REPO_PART.test(owner) || !REPO_PART.test(repo)) {
      return [];
    }
    return repoTools.get(`${owner}/${repo}`.toLowerCase()) ?? [];
  }
  return [];
}

/**
 * The os and arch in a mise user agent
 * (`mise/2026.10.10 linux-x64 (2026-10-11) bash`), or empty strings.
 */
export function misePlatform(userAgent) {
  const token = String(userAgent || "").split(/\s+/)[1] ?? "";
  const dash = token.indexOf("-");
  if (dash <= 0 || token.startsWith("(")) return { os: "", arch: "" };
  return { os: token.slice(0, dash), arch: token.slice(dash + 1) };
}

/** Whether a mise release (`YYYY.M.P`) sends the install beacon. */
export function sendsBeacon(miseVersion) {
  const parts = String(miseVersion || "")
    .split(/[^0-9]/)
    .slice(0, 3)
    .map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isInteger(n))) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (parts[i] !== BEACON_MIN_MISE_VERSION[i]) {
      return parts[i] > BEACON_MIN_MISE_VERSION[i];
    }
  }
  return true;
}

function addTo(map, key, user) {
  let users = map.get(key);
  if (!users) {
    users = new Set();
    map.set(key, users);
  }
  users.add(user);
}

/** One UTC day's tool lookups, by distinct machine. */
export class ToolLookupDay {
  constructor() {
    this.users = new Set();
    this.tools = new Map();
    this.beaconClientTools = new Map();
    this.platforms = new Map();
    this.requests = new Map();
  }

  /**
   * Record that machine `user` (a numeric IP hash) looked up `tools` from
   * `platform`; `beaconClient` when its mise release sends the beacon.
   */
  add(user, tools, platform, beaconClient) {
    if (tools.length === 0) return;
    this.users.add(user);
    for (const tool of tools) {
      addTo(this.tools, tool, user);
      if (beaconClient) addTo(this.beaconClientTools, tool, user);
      addTo(this.platforms, `${tool}\0${platform.os}\0${platform.arch}`, user);
      this.requests.set(tool, (this.requests.get(tool) ?? 0) + 1);
    }
  }

  rollups() {
    return {
      uniqueUsers: this.users.size,
      requests: [...this.requests.values()].reduce((a, b) => a + b, 0),
      tools: [...this.tools].map(([tool, users]) => ({
        tool,
        unique_users: users.size,
        beacon_client_users: this.beaconClientTools.get(tool)?.size ?? 0,
        requests: this.requests.get(tool) ?? 0,
      })),
      platforms: [...this.platforms].map(([key, users]) => {
        const [tool, os, arch] = key.split("\0");
        return { tool, os, arch, unique_users: users.size };
      }),
    };
  }
}
