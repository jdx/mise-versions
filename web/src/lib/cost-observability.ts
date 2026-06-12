const DEFAULT_SAMPLE_RATE = 0.01;

export type CostProbe = {
  route: string;
  status: number;
  duration_ms: number;
  cache?: "edge" | "kv" | "d1" | "none";
  tracking?: "queued" | "ci_skipped" | "none";
  d1_write?: "attempted" | "skipped";
};

export function logCostProbe(probe: CostProbe): void {
  if (Math.random() >= DEFAULT_SAMPLE_RATE) return;

  console.info("cost_probe", JSON.stringify(probe));
}
