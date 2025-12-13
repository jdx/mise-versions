import { Router, Route, Switch } from "wouter-preact";
import { HomePage } from "./pages/HomePage";
import { RecentPage } from "./pages/RecentPage";
import { ToolPage } from "./pages/ToolPage";

export function App() {
  return (
    <div class="min-h-screen">
      <header class="bg-white border-b border-gray-200">
        <div class="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <a href="/" class="text-xl font-bold text-gray-900 hover:text-gray-700">
            mise versions
          </a>
          <nav class="flex gap-4">
            <a href="/" class="text-gray-600 hover:text-gray-900">
              All Tools
            </a>
            <a href="/recent" class="text-gray-600 hover:text-gray-900">
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
