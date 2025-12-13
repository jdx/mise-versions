import { Router, Route, Switch } from "wouter-preact";
import { HomePage } from "./pages/HomePage";
import { RecentPage } from "./pages/RecentPage";
import { ToolPage } from "./pages/ToolPage";

export function App() {
  return (
    <div class="min-h-screen">
      <header class="bg-dark-800 border-b border-dark-600">
        <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <a
            href="/"
            class="text-xl font-bold text-neon-purple hover:text-neon-pink transition-colors"
          >
            mise versions
          </a>
          <nav class="flex gap-6">
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
