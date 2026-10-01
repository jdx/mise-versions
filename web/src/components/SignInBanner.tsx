import { useAuth, authUrls } from "../lib/use-auth";
import { GitHubIcon } from "./AuthButton";

export function SignInBanner() {
  const state = useAuth();

  // Signed in, but the token is gone from the pool (retired or expired).
  const lapsed = state.authenticated && !state.sharing;

  if (state.loading || (state.authenticated && state.sharing)) return null;

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
      </div>
    </aside>
  );
}
