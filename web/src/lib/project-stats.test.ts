import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseProjects,
  projectSummary,
  projectComparison,
  projectMilestones,
  parseComparison,
  type Project,
} from "./project-stats";
const project = (name = "hk"): Project => ({
  repo: `jdx/${name}`,
  name,
  history: Array.from({ length: 40 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
    stars: 90 + i,
    rank: i < 10 ? 120 : 80,
    installs: null,
  })),
  downloads: [],
});
test("project parsing preserves missing metrics and canonical repos, deduplicates dates", () => {
  const result = parseProjects(
    "# comment\naubepkg/aube",
    "date,repo_name,github_stars,brew_rank,brew_installs,brew_pct\n2026-09-01,aube,0,,,\n2026-09-02,aube,100,,,\n2026-09-02,aube,101,,0,\n2026-02-30,aube,300,1,2,3",
    "date,repo_name,release_downloads\n2026-09-02,aube,0",
  );
  assert.equal(result[0].repo, "aubepkg/aube");
  assert.deepEqual(result[0].history, [
    { date: "2026-09-02", stars: 101, rank: null, installs: 0 },
  ]);
  assert.equal(result[0].downloads[0].downloads, 0);
  assert.throws(() => parseProjects("jdx/aube", "wrong", "wrong"));
});
test("summaries require exact baseline and comparisons use one shared window", () => {
  const p = project(),
    end = p.history.at(-1)!.date;
  assert.equal(projectSummary(p).gain, 30);
  assert.equal(projectSummary(p).average, undefined);
  const missing = { ...p, history: p.history.filter((_, i) => i !== 9) };
  assert.equal(projectSummary(missing).gain, null);
  assert.equal(projectComparison([p, missing], end, false).length, 1);
  const comparison = projectComparison([p], end, true)[0];
  assert.equal(comparison.points[0].value, 0);
  assert.equal(comparison.points.at(-1)!.value, (30 / 99) * 100);
});
test("milestones are observed crossings, never inferred from first snapshot", () => {
  const p = project();
  const events = projectMilestones(p);
  assert(events.some((e) => e.text.includes("100 stars")));
  assert(events.some((e) => e.text.includes("top 100")));
  assert(
    !projectMilestones({ ...p, history: [p.history.at(-1)!] }).some((e) =>
      e.text.includes("100 stars"),
    ),
  );
});
test("comparison data rejects bad schemas and ignores synthetic zero history", () => {
  assert.deepEqual(
    parseComparison("hk", "date,hk_stars,prek_stars\n2026-09-01,100,0")
      .series[1].points,
    [],
  );
  assert.throws(() => parseComparison("hk", "date,count\n2026-09-01,5"));
});
