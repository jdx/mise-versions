import { useMemo, useState } from "preact/hooks";
import { releaseMonths, type TimelineRelease } from "../lib/release-timeline";
export function ReleaseTimeline({ versions }: { versions: TimelineRelease[] }) {
  const history = useMemo(() => releaseMonths(versions), [versions]);
  const [range, setRange] = useState("12");
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState(false);
  const months = range === "all" ? history.months : history.months.slice(-12);
  const current = months.find((m) => m.month === selected) ?? months.at(-1);
  const max = Math.max(...months.map((m) => m.releases.length), 1);
  const monthLabel = (month: string) =>
    new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
  if (!current)
    return (
      <p class="inline-notice">
        No release dates are available for these versions.
      </p>
    );
  const choose = (month: string) => {
    setSelected(month);
    setExpanded(false);
  };
  return (
    <section class="release-timeline" aria-label="Release timeline">
      <div class="release-timeline-heading">
        <div>
          <h3>Release timeline</h3>
          <p>
            {months.reduce((total, month) => total + month.releases.length, 0)}{" "}
            releases · {monthLabel(months[0].month)}–
            {monthLabel(months.at(-1)!.month)}
            {history.undated > 0 ? ` · ${history.undated} without dates` : ""}
          </p>
        </div>
        <select
          aria-label="Release timeline range"
          value={range}
          onChange={(e) => {
            setRange(e.currentTarget.value);
            setExpanded(false);
          }}
        >
          <option value="12">Latest 12 months</option>
          <option value="all">All history</option>
        </select>
      </div>
      <div
        class="release-months"
        role="group"
        aria-label="Releases by month"
        onKeyDown={(e) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
            return;
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
          ];
          const i = buttons.indexOf(e.target as HTMLButtonElement);
          if (i < 0) return;
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : Math.max(
                    0,
                    Math.min(
                      buttons.length - 1,
                      i + (e.key === "ArrowRight" ? 1 : -1),
                    ),
                  );
          choose(months[next].month);
          buttons[next].focus();
        }}
      >
        {months.map((m, i) => (
          <button
            type="button"
            key={m.month}
            class="release-month"
            aria-pressed={m.month === current.month}
            tabIndex={m.month === current.month ? 0 : -1}
            aria-label={`${monthLabel(m.month)}: ${m.releases.length} releases`}
            title={`${monthLabel(m.month)} · ${m.releases.length} releases`}
            onClick={() => choose(m.month)}
          >
            <span
              class="release-month-bar"
              style={{ height: `${(m.releases.length / max) * 72}px` }}
            />
            <span class="release-month-label">
              {months.length <= 12
                ? new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString(
                    "en-US",
                    { month: "short", timeZone: "UTC" },
                  )
                : m.month.endsWith("-01")
                  ? m.month.slice(0, 4)
                  : ""}
            </span>
          </button>
        ))}
      </div>
      <div class="release-selection" aria-live="polite">
        <strong>{monthLabel(current.month)}</strong>
        <span>{current.releases.length} releases</span>
      </div>
      <div class="release-preview">
        {current.releases.slice(0, expanded ? undefined : 4).map((v) => {
          const content = (
            <>
              <span class="font-mono">{v.version}</span>
              <time dateTime={v.created_at!}>
                {new Date(v.created_at!).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  timeZone: "UTC",
                })}
              </time>
            </>
          );
          const safe = v.release_url?.startsWith("https://");
          return safe ? (
            <a
              key={v.version}
              href={v.release_url!}
              target="_blank"
              rel="noopener noreferrer"
            >
              {content}
              <span aria-hidden="true">↗</span>
            </a>
          ) : (
            <div key={v.version}>{content}</div>
          );
        })}
        {!current.releases.length && <p>No releases recorded this month.</p>}
      </div>
      {current.releases.length > 4 && (
        <button
          type="button"
          class="release-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? "Show fewer"
            : `Show all ${current.releases.length} releases`}
        </button>
      )}
    </section>
  );
}
