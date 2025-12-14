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
        const data = await response.json();
        setState({
          authenticated: data.authenticated,
          username: data.username || null,
          loading: false,
        });
      } catch (error) {
        console.error("Failed to check auth:", error);
        setState({
          authenticated: false,
          username: null,
          loading: false,
        });
      }
    }

    checkAuth();
  }, []);

  return state;
}
