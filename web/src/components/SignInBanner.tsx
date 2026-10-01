import { useState, useEffect } from "preact/hooks";
import { useAuth, authUrls } from "../lib/use-auth";
import { GitHubIcon } from "./AuthButton";

const DISMISS_KEY = "mise-signin-banner-dismissed";

export function SignInBanner() {
  const state = useAuth();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      setDismissed(false);
    }
  }, []);

  if (state.loading || state.authenticated || dismissed) return null;

  const { loginUrl } = authUrls();

  return (
    <aside class="signin-banner" aria-label="Share your GitHub rate limit">
      <div class="signin-banner-inner">
        <p>
          <strong>Lend a little of your GitHub rate limit.</strong> We spread
          version lookups thinly across many people so no one account carries
          the load. <a href="/share-rate-limit">How it works</a>
        </p>
        <a href={loginUrl} class="auth-signin auth-signin-primary">
          <GitHubIcon />
          <span>Sign in with GitHub</span>
        </a>
        <button
          type="button"
          class="signin-banner-dismiss"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {}
          }}
        >
          ×
        </button>
      </div>
    </aside>
  );
}
