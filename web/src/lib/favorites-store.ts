// Client-side state for the signed-in user's favorite tools. Every island on
// the page shares this module, so the list is fetched once per page load.
import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "./login-url";

export type FavoritesStatus = "loading" | "anonymous" | "ready" | "error";

interface FavoritesState {
  status: FavoritesStatus;
  tools: ReadonlySet<string>;
}

const PENDING_KEY = "mise-pending-favorite";

let state: FavoritesState = { status: "loading", tools: new Set() };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setState(next: FavoritesState) {
  state = next;
  for (const listener of listeners) listener();
}

function takePending(): string | null {
  try {
    const tool = sessionStorage.getItem(PENDING_KEY);
    sessionStorage.removeItem(PENDING_KEY);
    return tool;
  } catch {
    return null;
  }
}

function rememberPending(tool: string) {
  try {
    sessionStorage.setItem(PENDING_KEY, tool);
  } catch {}
}

// Writes for one tool go out one at a time, in click order. Two quick clicks
// would otherwise race on the server and could leave it disagreeing with the
// star the visitor sees.
const writes = new Map<string, Promise<unknown>>();

function send(method: "PUT" | "DELETE", tool: string): Promise<boolean> {
  const result = (writes.get(tool) ?? Promise.resolve()).then(() =>
    request(method, tool),
  );
  const tail = result.finally(() => {
    if (writes.get(tool) === tail) writes.delete(tool);
  });
  writes.set(tool, tail);
  return result;
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

async function load() {
  try {
    const response = await fetch("/api/favorites");
    if (response.status === 401) {
      setState({ status: "anonymous", tools: new Set() });
      return;
    }
    if (!response.ok) throw new Error("Favorites unavailable");
    const data = await response.json<{ favorites: string[] }>();
    setState({ status: "ready", tools: new Set(data.favorites) });
  } catch {
    setState({ status: "error", tools: new Set() });
    return;
  }

  // Finish the favorite the visitor clicked before they went to sign in.
  const pending = takePending();
  if (pending && !state.tools.has(pending)) await toggleFavorite(pending);
}

function ensureLoaded(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  loading ??= load();
  return loading;
}

export async function toggleFavorite(tool: string): Promise<void> {
  // A click that lands before the list arrives waits for it, rather than being
  // dropped: signed-out clicks still need to start the sign-in.
  if (state.status === "loading") await ensureLoaded();
  if (state.status === "anonymous") {
    rememberPending(tool);
    window.location.assign(loginUrl());
    return;
  }
  if (state.status !== "ready") return;

  const adding = !state.tools.has(tool);
  const optimistic = new Set(state.tools);
  if (adding) optimistic.add(tool);
  else optimistic.delete(tool);
  const previous = state.tools;
  setState({ status: "ready", tools: optimistic });

  if (!(await send(adding ? "PUT" : "DELETE", tool))) {
    // Only roll back this tool; another toggle may have landed meanwhile.
    const reverted = new Set(state.tools);
    if (previous.has(tool)) reverted.add(tool);
    else reverted.delete(tool);
    setState({ status: "ready", tools: reverted });
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
    toggle: toggleFavorite,
  };
}
