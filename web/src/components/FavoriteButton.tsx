import { useFavorites } from "../lib/favorites-store";
import "../styles/member.css";

interface FavoriteButtonProps {
  tool: string;
}

export function FavoriteButton({ tool }: FavoriteButtonProps) {
  const { status, has, toggle } = useFavorites();
  const favorited = has(tool);
  const label = favorited
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
      disabled={status === "error"}
      onClick={() => void toggle(tool)}
    >
      <span aria-hidden="true">{favorited ? "★" : "☆"}</span>
    </button>
  );
}
