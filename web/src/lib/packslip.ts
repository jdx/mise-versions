import catalog from "../data/packslip.json";
import type { PackslipMetadata } from "./packslip-manifest";

export function getPackslip(
  github?: string | null,
): PackslipMetadata | undefined {
  return github
    ? (catalog as Record<string, PackslipMetadata>)[github]
    : undefined;
}

export function getPackslipForBackends(
  backends?: string[],
): PackslipMetadata | undefined {
  for (const backend of backends ?? []) {
    const repo =
      backend.match(/^(?:aqua|github|ubi):([\w.-]+\/[\w.-]+)(?:\[|$)/)?.[1] ??
      backend.match(/^packslip:github\.com\/([\w.-]+\/[\w.-]+)(?:\[|$)/)?.[1];
    const metadata = getPackslip(repo);
    if (metadata) return metadata;
  }
}
