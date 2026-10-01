import { useFavorites } from "../lib/favorites-store";
import "../styles/member.css";

interface FavoriteButtonProps {
  tool: string;
}

export function FavoriteButton({ tool }: FavoriteButtonProps) {
  const { status, has, toggle } = useFavorites();
  const favorited = has(tool);
  // A click before the list has arrived could not tell "add" from "remove", so
  // the star waits (the signed-out answer comes back in a moment). If the load
  // failed, it stays clickable and a click tries again.
  const label =
    status === "loading"
      ? "Loading favorites…"
      : status === "error"
        ? "Favorites could not be loaded. Click to try again"
        : favorited
          ? `Remove ${tool} from favorites`
          : status === "anonymous"
            ? `Sign in with GitHub to favorite ${tool}`
            : `Add ${tool} to favorites`;

  return (
    <button
      type="button"
      class="favorite-button"
      aria-pressed={favorited}
      aria-label={label}
      title={label}
      disabled={status === "loading"}
      aria-busy={status === "loading"}
      onClick={() => void toggle(tool)}
    >
      <span aria-hidden="true">{favorited ? "★" : "☆"}</span>
    </button>
  );
}
