import { useState, useEffect } from "preact/hooks";
import type { AuthStatusResponse } from "./auth";

export interface AuthState {
  authenticated: boolean;
  username: string | null;
  lookups: number | null;
  // Signed in with a token in the pool. Unknown (true) if the lookup failed.
  sharing: boolean;
  loading: boolean;
}

const SIGNED_OUT: AuthState = {
  authenticated: false,
  username: null,
  lookups: null,
  sharing: false,
  loading: false,
};

// Shared across components so the header button and banner make one request.
let pending: Promise<AuthState> | null = null;

function fetchAuth(): Promise<AuthState> {
  pending ??= (async () => {
    try {
      const response = await fetch("/api/auth/me");
      if (!response.headers.get("content-type")?.includes("application/json")) {
        return SIGNED_OUT;
      }
      const data = await response.json<AuthStatusResponse>();
      return {
        authenticated: data.authenticated,
        username: data.username || null,
        lookups: data.lookups ?? null,
        sharing: data.sharing ?? data.authenticated,
        loading: false,
      };
    } catch {
      return SIGNED_OUT;
    }
  })();
  return pending;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    username: null,
    lookups: null,
    sharing: false,
    loading: true,
  });

  useEffect(() => {
    fetchAuth().then(setState);
  }, []);

  return state;
}

export function authUrls() {
  const currentPath =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/";
  const returnTo = encodeURIComponent(currentPath);
  return {
    loginUrl: `/api/auth/login?return_to=${returnTo}`,
    logoutUrl: `/api/auth/logout?return_to=${returnTo}`,
  };
}
