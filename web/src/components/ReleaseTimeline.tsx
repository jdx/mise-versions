import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { releaseDays, type TimelineRelease } from "../lib/release-timeline";
export function ReleaseTimeline({ versions }: { versions: TimelineRelease[] }) {
  const history = useMemo(() => releaseDays(versions), [versions]);
  const [range, setRange] = useState("milestones");
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState(false);
  const milestones = history.days.filter((day) => day.milestones.length);
  const days =
    range === "milestones" && milestones.length
      ? milestones
      : range === "30"
        ? history.days.slice(-30)
        : history.days;
  const current = days.find((d) => d.date === selected) ?? days.at(-1);
  const rail = useRef<HTMLDivElement>(null);
  const start = days.length ? Date.parse(days[0].date) : 0;
  const end = days.length ? Date.parse(days.at(-1)!.date) : start;
  const position = (date: string) =>
    end === start ? 50 : 4 + (92 * (Date.parse(date) - start)) / (end - start);
  const lanes = [-Infinity, -Infinity, -Infinity];
  const labelLanes = days.map((day) => {
    if (!day.milestones.length) return -1;
    const x = position(day.date);
    const lane = lanes.findIndex((last) => x - last >= 8);
    if (lane >= 0) lanes[lane] = x;
    return lane;
  });
  const years = days.length
    ? Array.from(
        {
          length:
            new Date(end).getUTCFullYear() -
            new Date(start).getUTCFullYear() +
            1,
        },
        (_, i) => String(new Date(start).getUTCFullYear() + i),
      )
    : [];
  useEffect(() => {
    const container = rail.current;
    const dot = container?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (container && dot)
      container.scrollLeft =
        dot.offsetLeft - container.clientWidth / 2 + dot.clientWidth / 2;
  }, [current?.date, range]);
  const dateLabel = (date: string) =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  if (!current)
    return (
      <p class="inline-notice">
        No release dates are available for these versions.
      </p>
    );
  const choose = (date: string) => {
    setSelected(date);
    setExpanded(false);
  };
  return (
    <section class="release-timeline" aria-label="Release timeline">
      <div class="release-timeline-heading">
        <div>
          <h3>Release timeline</h3>
          <p>
            {range === "milestones" && milestones.length
              ? "Major versions · minor milestones for 0.x · spaced by date"
              : "One dot per release day · spaced by date"}
            {history.undated > 0 ? ` · ${history.undated} without dates` : ""}
          </p>
        </div>
        <select
          aria-label="Release timeline range"
          value={range === "milestones" && !milestones.length ? "all" : range}
          onChange={(e) => {
            setRange(e.currentTarget.value);
            setExpanded(false);
          }}
        >
          {milestones.length > 0 && (
            <option value="milestones">Milestones</option>
          )}
          <option value="30">Latest 30 release days</option>
          <option value="all">All history</option>
        </select>
      </div>
      <div
        class="release-dots"
        ref={rail}
        role="group"
        aria-label="Release days"
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
          choose(days[next].date);
          buttons[next].focus();
        }}
      >
        <div class="release-time-plot">
          {days.map((day, index) => (
            <button
              type="button"
              style={{
                left: `${position(day.date)}%`,
                "--label-top": `${labelLanes[index] * 22}px`,
              }}
              key={day.date}
              class={`release-stop ${day.milestones.length ? "release-stop-milestone" : ""}`}
              aria-pressed={day.date === current.date}
              tabIndex={day.date === current.date ? 0 : -1}
              aria-label={`${day.milestones.map((v) => `v${v}`).join(", ")}${day.milestones.length ? ", " : ""}${dateLabel(day.date)}: ${day.releases.length} releases`}
              title={day.releases.map((v) => v.version).join(", ")}
              onClick={() => choose(day.date)}
            >
              <span
                class={`release-stop-year ${day.milestones.length ? "release-milestone-label" : ""} ${labelLanes[index] < 0 ? "release-label-hidden" : ""}`}
              >
                {day.milestones.length
                  ? day.milestones.map((v) => `v${v}`).join(" · ")
                  : day.date.slice(0, 4)}
              </span>
              <span
                class={`release-dot ${day.releases.length > 1 ? "release-dot-multiple" : ""}`}
              />
            </button>
          ))}
          <span
            class="release-year-tick"
            style={{ left: "4%", transform: "none" }}
          >
            {new Date(start).toLocaleDateString("en-US", {
              month: "short",
              year: "numeric",
              timeZone: "UTC",
            })}
          </span>
          {end !== start && (
            <span
              class="release-year-tick"
              style={{ left: "96%", transform: "translateX(-100%)" }}
            >
              {new Date(end).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
                timeZone: "UTC",
              })}
            </span>
          )}
          {years.map((year) => {
            const date = `${year}-01-01`;
            if (position(date) < 14 || position(date) > 86) return null;
            return (
              <span
                class="release-year-tick"
                style={{ left: `${position(date)}%` }}
              >
                {year}
              </span>
            );
          })}
        </div>
      </div>
      <div class="release-trail-controls">
        <button
          type="button"
          disabled={current === days[0]}
          onClick={() => choose(days[days.indexOf(current) - 1].date)}
          aria-label="Previous release day"
        >
          ← Earlier
        </button>
        <span>
          {days.indexOf(current) + 1} / {days.length}{" "}
          {range === "milestones" && milestones.length
            ? "milestones"
            : "release days"}
        </span>
        <button
          type="button"
          disabled={current === days.at(-1)}
          onClick={() => choose(days[days.indexOf(current) + 1].date)}
          aria-label="Next release day"
        >
          Later →
        </button>
      </div>
      <div class="release-selection" aria-live="polite">
        <strong>{dateLabel(current.date)}</strong>
        <span>{current.releases.length} releases</span>
      </div>
      <div class="release-preview">
        {current.releases
          .toSorted(
            (a, b) =>
              Number(a.version.includes("/")) - Number(b.version.includes("/")),
          )
          .slice(0, expanded ? undefined : 4)
          .map((v) => {
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
        {!current.releases.length && <p>No releases recorded this day.</p>}
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
