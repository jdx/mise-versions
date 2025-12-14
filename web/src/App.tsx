import { Router, Route, Switch } from "wouter-preact";
import { useEffect, useState } from "preact/hooks";
import { HomePage } from "./pages/HomePage";
import { RecentPage } from "./pages/RecentPage";
import { ToolPage } from "./pages/ToolPage";

const WORKER_URL = "https://mise-versions-worker.jdx.dev";

function LoginStatus() {
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const login = params.get("login");
    const user = params.get("user");

    if (login === "success" && user) {
      setMessage({ type: "success", text: `Thanks for contributing, ${user}!` });
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
      // Auto-dismiss after 5 seconds
      setTimeout(() => setMessage(null), 5000);
    } else if (login === "error") {
      setMessage({ type: "error", text: "Login failed. Please try again." });
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => setMessage(null), 5000);
    }
  }, []);

  if (!message) return null;

  return (
    <div
      class={`fixed top-20 right-4 px-4 py-3 rounded-lg shadow-lg z-50 ${
        message.type === "success"
          ? "bg-green-900/90 border border-green-500 text-green-200"
          : "bg-red-900/90 border border-red-500 text-red-200"
      }`}
    >
      {message.text}
    </div>
  );
}

export function App() {
  return (
    <div class="min-h-screen">
      <LoginStatus />
      <header class="bg-dark-800 border-b border-dark-600">
        <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <a
            href="/"
            class="text-xl font-bold text-neon-purple hover:text-neon-pink transition-colors"
          >
            mise versions
          </a>
          <nav class="flex items-center gap-6">
            <a
              href="/"
              class="text-gray-400 hover:text-neon-purple transition-colors"
            >
              All Tools
            </a>
            <a
              href="/recent"
              class="text-gray-400 hover:text-neon-purple transition-colors"
            >
              Recently Updated
            </a>
            <a
              href={`${WORKER_URL}/auth/login`}
              class="flex items-center gap-2 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 border border-dark-500 rounded-lg text-gray-300 hover:text-white transition-colors"
            >
              <svg class="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              <span>Contribute Token</span>
            </a>
          </nav>
        </div>
      </header>
      <main class="max-w-6xl mx-auto px-4 py-8">
        <Router>
          <Switch>
            <Route path="/" component={HomePage} />
            <Route path="/recent" component={RecentPage} />
            <Route path="/:tool" component={ToolPage} />
          </Switch>
        </Router>
      </main>
    </div>
  );
}
