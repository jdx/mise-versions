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
let started = false;
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

async function send(method: "PUT" | "DELETE", tool: string): Promise<boolean> {
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

function ensureLoaded() {
  if (started || typeof window === "undefined") return;
  started = true;
  void load();
}

export async function toggleFavorite(tool: string): Promise<void> {
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
    ensureLoaded();
    // The store may have changed between render and subscribing.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    status: state.status,
    has: (tool: string) => state.tools.has(tool),
    toggle: toggleFavorite,
  };
}
