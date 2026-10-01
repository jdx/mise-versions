import { useEffect, useState } from "preact/hooks";
import { FavoriteButton } from "./FavoriteButton";
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

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
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
        if (!controller.signal.aborted) setState({ status: "error" });
      });
    return () => controller.abort();
  }, [attempt]);

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
        <li key={tool.name} class="watchlist-item">
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
            <span class="watchlist-version-number">
              {tool.latest_stable_version || tool.latest_version}
            </span>
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
