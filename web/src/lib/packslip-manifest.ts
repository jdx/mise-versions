export interface PackslipMetadata {
  project: string;
  version: string;
  publishedAt: string;
  manifestUrl: string;
  releaseUrl: string;
  publisher: string;
  capabilities: Array<{ label: string; detail: string }>;
  platforms: string[];
  binaries: string[];
  artifactCount: number;
  provenanceCount: number;
}

// Only called after the official CLI verifies the bundle's signature and log.
// Resource commands are metadata; the collector never executes them.
export function summarizePackslip(
  statement: any,
  verified: any,
  repo: string,
  manifestUrl: string,
  releaseUrl: string,
): PackslipMetadata {
  const p = statement?.predicate;
  if (
    statement?.predicateType !== "https://packslip.dev/release/v1" ||
    p?.project !== `github.com/${repo}` ||
    verified?.project !== p.project ||
    verified?.version !== p.version ||
    verified?.attested_by !== "vendor" ||
    verified?.scheme !== "sigstore-oidc" ||
    verified?.issuer !== "https://token.actions.githubusercontent.com" ||
    !verified?.key_id?.startsWith(`https://github.com/${repo}/`) ||
    !verified?.logged_at ||
    !Array.isArray(p.artifacts) ||
    !Array.isArray(p.resources ?? [])
  )
    throw new Error("Manifest does not match the verified vendor release");

  const resources = p.resources ?? [];
  const capabilities: PackslipMetadata["capabilities"] = [];
  const has = (kind: string) => resources.some((r: any) => r.kind === kind);
  if (has("completion")) {
    const shells = [
      ...new Set(
        resources
          .filter((r: any) => r.kind === "completion")
          .flatMap((r: any) => [r.shell, ...(r.shells ?? [])])
          .filter((s: any) => typeof s === "string"),
      ),
    ];
    capabilities.push({
      label: "Shell completions",
      detail: shells.length ? shells.join(" · ") : "Declared by the publisher",
    });
  }
  if (has("cli-spec")) {
    const usage = resources.some(
      (r: any) => r.kind === "cli-spec" && r.format === "usage",
    );
    capabilities.push({
      label: usage ? "Usage CLI spec" : "CLI specification",
      detail: usage
        ? "Enables generated completions and documentation"
        : "Machine-readable commands and options",
    });
  }
  const labels: Record<string, [string, string]> = {
    skill: ["Agent skills", "Instructions for coding agents"],
    man: ["Man pages", "Reference documentation for your terminal"],
    sbom: ["Software bill of materials", "Dependency inventory included"],
    desktop: ["Desktop integration", "Desktop entry declared"],
    icon: ["App icons", "Publisher-provided icons"],
    app: ["App bundle", "Native application bundle"],
  };
  for (const [kind, [label, detail]] of Object.entries(labels)) {
    if (has(kind)) capabilities.push({ label, detail });
  }
  const unique = (items: string[]) => [...new Set(items)].sort();
  return {
    project: p.project,
    version: p.version,
    publishedAt: p.published_at,
    manifestUrl,
    releaseUrl,
    publisher: repo.split("/")[0],
    capabilities,
    platforms: unique(
      p.artifacts
        .filter((a: any) => a.os && a.arch)
        .map((a: any) =>
          [
            a.os === "darwin"
              ? "macOS"
              : a.os === "linux"
                ? "Linux"
                : a.os === "windows"
                  ? "Windows"
                  : a.os,
            a.arch,
            a.libc,
          ]
            .filter(Boolean)
            .join(" / "),
        ),
    ),
    binaries: unique(
      p.artifacts.flatMap((a: any) =>
        (a.bin ?? []).map((b: any) =>
          typeof b === "string" ? b : (b.name ?? b.path),
        ),
      ),
    ),
    artifactCount: p.artifacts.length,
    provenanceCount: p.artifacts.filter(
      (a: any) => Array.isArray(a.provenance) && a.provenance.length,
    ).length,
  };
}
