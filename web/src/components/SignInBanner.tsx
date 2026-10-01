import { useState, useEffect } from "preact/hooks";
import { useAuth, authUrls } from "../lib/use-auth";
import { GitHubIcon } from "./AuthButton";

const DISMISS_KEY = "mise-signin-banner-dismissed";
const LAPSED_DISMISS_KEY = "mise-signin-banner-lapsed-dismissed";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function SignInBanner() {
  const state = useAuth();
  // Hidden until we've read storage so a dismissed banner never flashes.
  const [ready, setReady] = useState(false);
  const [dismissedKeys, setDismissedKeys] = useState<string[]>([]);

  useEffect(() => {
    setDismissedKeys(
      [DISMISS_KEY, LAPSED_DISMISS_KEY].filter((key) => readFlag(key)),
    );
    setReady(true);
  }, []);

  // Signed in, but the token is gone from the pool (retired or expired).
  const lapsed = state.authenticated && !state.sharing;
  const key = lapsed ? LAPSED_DISMISS_KEY : DISMISS_KEY;

  if (
    state.loading ||
    !ready ||
    (state.authenticated && state.sharing) ||
    dismissedKeys.includes(key)
  )
    return null;

  const { loginUrl } = authUrls();

  return (
    <aside class="signin-banner" aria-label="Share your GitHub rate limit">
      <div class="signin-banner-inner">
        <p>
          {lapsed ? (
            <>
              <strong>You're no longer sharing your rate limit.</strong> Your
              earlier token was retired or expired. Sign in again to keep
              lending a little of it.{" "}
            </>
          ) : (
            <>
              <strong>Lend a little of your GitHub rate limit.</strong> We
              spread version lookups thinly across many people so no one account
              carries the load.{" "}
            </>
          )}
          <a href="/share-rate-limit">How it works</a>
        </p>
        <a href={loginUrl} class="auth-signin auth-signin-primary">
          <GitHubIcon />
          <span>{lapsed ? "Sign in again" : "Sign in with GitHub"}</span>
        </a>
        <button
          type="button"
          class="signin-banner-dismiss"
          aria-label="Dismiss"
          onClick={() => {
            setDismissedKeys([...dismissedKeys, key]);
            try {
              localStorage.setItem(key, "1");
            } catch {}
          }}
        >
          ×
        </button>
      </div>
    </aside>
  );
}
