import { useCallback, useEffect, useState } from "preact/hooks";

export interface DownloadDetails {
  monthly: Array<{ month: string; count: number }>;
  byVersion: Array<{ version: string; count: number }>;
  byOs: Array<{ os: string | null; count: number }>;
}

export type DownloadDetailsState =
  | { status: "loading" }
  | { status: "locked" }
  | { status: "error" }
  | { status: "ready"; data: DownloadDetails };

// The downloads panel and the versions table are separate islands that need
// the same numbers. They share one entry per tool, so a single request serves
// both and a retry from either one updates both.
interface Entry {
  state: DownloadDetailsState;
  started: boolean;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryFor(tool: string): Entry {
  let entry = entries.get(tool);
  if (!entry) {
    entry = {
      state: { status: "loading" },
      started: false,
      listeners: new Set(),
    };
    entries.set(tool, entry);
  }
  return entry;
}

function publish(entry: Entry, state: DownloadDetailsState) {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

async function load(tool: string) {
  const entry = entryFor(tool);
  entry.started = true;
  publish(entry, { status: "loading" });
  try {
    const response = await fetch(
      `/api/downloads/${encodeURIComponent(tool)}/details`,
    );
    if (response.status === 401) return publish(entry, { status: "locked" });
    if (!response.ok) return publish(entry, { status: "error" });
    publish(entry, {
      status: "ready",
      data: await response.json<DownloadDetails>(),
    });
  } catch {
    publish(entry, { status: "error" });
  }
}

export function useDownloadDetails(tool: string) {
  const [, rerender] = useState(0);

  useEffect(() => {
    const entry = entryFor(tool);
    const listener = () => rerender((n) => n + 1);
    entry.listeners.add(listener);
    if (!entry.started) void load(tool);
    // The entry may have changed between render and subscribing.
    listener();
    return () => {
      entry.listeners.delete(listener);
    };
  }, [tool]);

  const retry = useCallback(() => void load(tool), [tool]);
  return { state: entryFor(tool).state, retry };
}
