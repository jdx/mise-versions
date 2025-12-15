import { useState, useEffect } from "preact/hooks";

interface AuthState {
  authenticated: boolean;
  username: string | null;
  loading: boolean;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    authenticated: false,
    username: null,
    loading: true,
  });

  useEffect(() => {
    async function checkAuth() {
      try {
        const response = await fetch("/auth/me");
        // Check if response is JSON (Pages Functions return JSON, dev server returns HTML)
        const contentType = response.headers.get("content-type");
        if (!contentType?.includes("application/json")) {
          // Not running with Pages Functions (local dev), assume not authenticated
          setState({ authenticated: false, username: null, loading: false });
          return;
        }
        const data = await response.json();
        setState({
          authenticated: data.authenticated,
          username: data.username || null,
          loading: false,
        });
      } catch {
        setState({ authenticated: false, username: null, loading: false });
      }
    }

    checkAuth();
  }, []);

  return state;
}
