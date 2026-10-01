// Client-side state for the signed-in user's favorite tools. Every island on
// the page shares this module, so the list is fetched once per page load.
//
// Two sets are tracked: `tools` is what the stars show (it moves the moment
// someone clicks), `confirmed` is what the server has actually saved.
import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "./login-url";

export type FavoritesStatus = "loading" | "anonymous" | "ready" | "error";

interface FavoritesState {
  status: FavoritesStatus;
  tools: ReadonlySet<string>;
  confirmed: ReadonlySet<string>;
}

const PENDING_KEY = "mise-pending-favorite";

let state: FavoritesState = {
  status: "loading",
  tools: new Set(),
  confirmed: new Set(),
};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: FavoritesState) {
  state = next;
  for (const listener of listeners) listener();
}

function peekPending(): string | null {
  try {
    return sessionStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
}

function setPending(tool: string | null) {
  try {
    if (tool) sessionStorage.setItem(PENDING_KEY, tool);
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

async function request(
  method: "PUT" | "DELETE",
  tool: string,
): Promise<boolean> {
  try {
    const response = await fetch("/api/favorites", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function withTool(set: ReadonlySet<string>, tool: string, present: boolean) {
  const next = new Set(set);
  if (present) next.add(tool);
  else next.delete(tool);
  return next;
}

// Writes for one tool go out one at a time, in click order. Two quick clicks
// would otherwise race on the server and could leave it disagreeing with the
// star the visitor sees.
const writes = new Map<string, Promise<unknown>>();

// Show `wanted` immediately, save it, and resolve to whether the server
// accepted it. When the last queued write for the tool settles, the star is
// set to what the server really has, so failed writes never leave it wrong.
function setFavorite(tool: string, wanted: boolean): Promise<boolean> {
  setState({ ...state, tools: withTool(state.tools, tool, wanted) });

  const result = (writes.get(tool) ?? Promise.resolve()).then(async () => {
    const ok = await request(wanted ? "PUT" : "DELETE", tool);
    if (ok) {
      setState({
        ...state,
        confirmed: withTool(state.confirmed, tool, wanted),
      });
    }
    return ok;
  });
  const tail = result.then(() => {
    if (writes.get(tool) !== tail) return;
    writes.delete(tool);
    setState({
      ...state,
      tools: withTool(state.tools, tool, state.confirmed.has(tool)),
    });
  });
  writes.set(tool, tail);
  return result;
}

async function load() {
  try {
    const response = await fetch("/api/favorites");
    if (response.status === 401) {
      setState({
        status: "anonymous",
        tools: new Set(),
        confirmed: new Set(),
      });
      return;
    }
    if (!response.ok) throw new Error("Favorites unavailable");
    const data = await response.json<{ favorites: string[] }>();
    const saved = new Set(data.favorites);
    setState({ status: "ready", tools: saved, confirmed: saved });
  } catch {
    setState({ status: "error", tools: new Set(), confirmed: new Set() });
    return;
  }

  // Finish the favorite the visitor clicked before they went to sign in. It
  // stays remembered until the server has saved it, so a failure is retried on
  // the next page load.
  const pending = peekPending();
  if (!pending) return;
  if (state.confirmed.has(pending) || (await setFavorite(pending, true))) {
    setPending(null);
  }
}

export function ensureLoaded(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  loading ??= load();
  return loading;
}

export function favoritesSnapshot(): Readonly<FavoritesState> {
  return state;
}

export async function toggleFavorite(tool: string): Promise<void> {
  switch (state.status) {
    case "anonymous":
      setPending(tool);
      window.location.assign(loginUrl());
      return;
    case "error":
      // The list never loaded; a click is a request to try again.
      loading = null;
      await ensureLoaded();
      return;
    case "ready":
      await setFavorite(tool, !state.tools.has(tool));
      return;
    default:
      // Still loading: the star is disabled, so this is not reachable by click.
      return;
  }
}

export function useFavorites() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((n) => n + 1);
    listeners.add(listener);
    void ensureLoaded();
    // The store may have changed between render and subscribing.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    status: state.status,
    has: (tool: string) => state.tools.has(tool),
    tools: state.tools,
    confirmed: state.confirmed,
    toggle: toggleFavorite,
  };
}
