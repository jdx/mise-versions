import { useEffect, useRef, useState } from "preact/hooks";
import { FavoriteButton } from "./FavoriteButton";
import { useFavorites } from "../lib/favorites-store";
import { SignInPrompt } from "./SignInPrompt";
import { formatRelativeTime } from "../utils/time";
import "../styles/member.css";

interface WatchedTool {
  name: string;
  description: string | null;
  backend: string | null;
  latest_version: string;
  latest_stable_version: string | null;
  last_updated: string | null;
  downloads_30d: number;
}

type LoadState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "error" }
  | { status: "ready"; tools: WatchedTool[] };

function cleanBackend(backend: string): string {
  return backend.replace(/\[.*\]$/, "");
}

export function FavoritesList() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const favorites = useFavorites();

  useEffect(() => {
    const controller = new AbortController();
    // Refetches after the first load keep showing the current list.
    setState((current) =>
      current.status === "ready" ? current : { status: "loading" },
    );
    fetch("/api/favorites?details=1", { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) return setState({ status: "anonymous" });
        if (!response.ok) throw new Error("Favorites unavailable");
        const data = await response.json<{ tools: WatchedTool[] }>();
        // Most recently released first: this page is a watchlist.
        const tools = [...data.tools].sort((a, b) =>
          (b.last_updated ?? "").localeCompare(a.last_updated ?? ""),
        );
        setState({ status: "ready", tools });
      })
      .catch(() => {
        // A failed refetch must not replace a list that is already showing.
        if (!controller.signal.aborted) {
          setState((current) =>
            current.status === "ready" ? current : { status: "error" },
          );
        }
      });
    return () => controller.abort();
  }, [attempt]);

  // A favorite saved after this list loaded (for example the one picked just
  // before signing in) is missing from it: fetch again to pick it up.
  // A name can stay unlisted for good (the tool was removed from the registry),
  // so fetch again only when the set of unlisted names changes.
  const refetchedFor = useRef("");
  const unlisted =
    state.status === "ready"
      ? [...favorites.confirmed]
          .filter((name) => !state.tools.some((t) => t.name === name))
          .sort()
          .join(",")
      : "";
  useEffect(() => {
    if (unlisted && unlisted !== refetchedFor.current) {
      refetchedFor.current = unlisted;
      setAttempt((n) => n + 1);
    }
  }, [unlisted]);

  if (state.status === "loading") {
    return <p class="inline-notice">Loading your favorites…</p>;
  }
  if (state.status === "anonymous") {
    return (
      <SignInPrompt>
        Sign in to save tools and see their latest versions here.
      </SignInPrompt>
    );
  }
  if (state.status === "error") {
    return (
      <div class="inline-notice" role="alert">
        Your favorites are unavailable.
        <button onClick={() => setAttempt((n) => n + 1)}>Try again</button>
      </div>
    );
  }
  if (state.tools.length === 0) {
    return (
      <div class="empty-state">
        <p>No favorites yet.</p>
        <p>
          Press ☆ next to a tool on the <a href="/">tools list</a> to follow it
          here.
        </p>
      </div>
    );
  }

  return (
    <ul class="watchlist">
      {state.tools.map((tool) => (
        <li
          key={tool.name}
          class={`watchlist-item${favorites.has(tool.name) ? "" : " watchlist-item-removed"}`}
        >
          <FavoriteButton tool={tool.name} />
          <div class="watchlist-main">
            <a class="watchlist-name" href={`/tools/${tool.name}`}>
              {tool.name}
            </a>
            {tool.description && (
              <p class="watchlist-description">{tool.description}</p>
            )}
            <p class="watchlist-meta">
              {tool.backend && <span>{cleanBackend(tool.backend)}</span>}
              <span>{tool.downloads_30d.toLocaleString()} downloads / 30d</span>
            </p>
          </div>
          <div class="watchlist-version">
            <span class="watchlist-version-number">{tool.latest_version}</span>
            {tool.latest_stable_version &&
              tool.latest_stable_version !== tool.latest_version && (
                <span class="watchlist-version-age">
                  stable {tool.latest_stable_version}
                </span>
              )}
            {tool.last_updated && (
              <span class="watchlist-version-age">
                {formatRelativeTime(tool.last_updated)}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
