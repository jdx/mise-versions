#!/usr/bin/env node
// Deploys the GitHub-mirror Cloudflare Snippet (snippets/github-mirror-cache.js)
// and its snippet rule on the jdx.dev zone. See CLAUDE.md.
//
//   CLOUDFLARE_API_TOKEN=... node scripts/deploy-snippet.js [--dry-run]
//   CLOUDFLARE_API_TOKEN=... node scripts/deploy-snippet.js --remove
//
// The token needs Zone > Snippets > Edit (and Zone > Zone > Read unless
// CLOUDFLARE_ZONE_ID is set). `--remove` deletes only this snippet's rule,
// which stops the snippet from running (the rollback); the snippet code is
// left in place.
//
// PUT /snippets/snippet_rules replaces every snippet rule on the zone, so the
// existing rules are read first and only this snippet's rule is replaced.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const ZONE_NAME = "jdx.dev";
export const SNIPPET_NAME = "github_mirror_cache";
const SNIPPET_FILE = fileURLToPath(
  new URL("../snippets/github-mirror-cache.js", import.meta.url),
);
const MAX_SNIPPET_BYTES = 32 * 1024;

// Only GETs for mirror attestations and exact-tag releases on the Worker's
// custom domains. The snippet re-checks the path itself and passes anything
// else through, so this only keeps it from running needlessly.
export const SNIPPET_RULE = {
  snippet_name: SNIPPET_NAME,
  description:
    "Serve cached GitHub-mirror attestations and exact-tag releases without the mise-versions Worker",
  enabled: true,
  expression: [
    'http.host in {"mise-versions.jdx.dev" "mise-tools.jdx.dev"}',
    'http.request.method eq "GET"',
    'starts_with(http.request.uri.path, "/api/github/repos/")',
    '(http.request.uri.path contains "/attestations/" or (http.request.uri.path contains "/releases/" and not ends_with(http.request.uri.path, "/releases/latest")))',
  ].join(" and "),
};

/**
 * The zone's snippet rules with this snippet's rule replaced by `rule`, or
 * removed when `rule` is null. Other rules keep their order and settings;
 * read-only fields the API returns are dropped.
 */
export function upsertSnippetRule(existing, rule) {
  const others = (existing ?? [])
    .filter((r) => r.snippet_name !== SNIPPET_NAME)
    .map(({ snippet_name, expression, description, enabled }) => ({
      snippet_name,
      expression,
      description,
      enabled,
    }));
  return rule ? [...others, rule] : others;
}

async function api(token, method, path, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  const response = await fetch(`${API}${path}`, { method, headers, body });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    throw new Error(
      `${method} ${path} failed (${response.status}): ${JSON.stringify(data.errors ?? data)}`,
    );
  }
  return data.result;
}

async function zoneId(token) {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;
  const zones = await api(token, "GET", `/zones?name=${ZONE_NAME}`);
  if (!zones?.[0]?.id) throw new Error(`zone ${ZONE_NAME} not found`);
  return zones[0].id;
}

async function main(args) {
  const dryRun = args.includes("--dry-run");
  const remove = args.includes("--remove");
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set");
  const zone = await zoneId(token);

  if (!remove) {
    const source = await readFile(SNIPPET_FILE);
    if (source.length > MAX_SNIPPET_BYTES) {
      throw new Error(
        `snippet is ${source.length} bytes; the limit is ${MAX_SNIPPET_BYTES}`,
      );
    }
    const mainModule = basename(SNIPPET_FILE);
    console.log(
      `${dryRun ? "would upload" : "uploading"} snippet ${SNIPPET_NAME} (${source.length} bytes)`,
    );
    if (!dryRun) {
      const form = new FormData();
      form.append(
        "files",
        new Blob([source], { type: "application/javascript+module" }),
        mainModule,
      );
      form.append("metadata", JSON.stringify({ main_module: mainModule }));
      await api(token, "PUT", `/zones/${zone}/snippets/${SNIPPET_NAME}`, form);
    }
  }

  const existing = await api(
    token,
    "GET",
    `/zones/${zone}/snippets/snippet_rules`,
  );
  const rules = upsertSnippetRule(existing, remove ? null : SNIPPET_RULE);
  console.log(
    `${dryRun ? "would set" : "setting"} ${rules.length} snippet rule(s):\n${JSON.stringify(rules, null, 2)}`,
  );
  if (!dryRun) {
    await api(token, "PUT", `/zones/${zone}/snippets/snippet_rules`, { rules });
  }
  console.log("done");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
