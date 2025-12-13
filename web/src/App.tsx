import { Router, Route } from "wouter-preact";
import { HomePage } from "./pages/HomePage";
import { ToolPage } from "./pages/ToolPage";

export function App() {
  return (
    <div class="min-h-screen">
      <header class="bg-white border-b border-gray-200">
        <div class="max-w-6xl mx-auto px-4 py-4">
          <a href="/" class="text-xl font-bold text-gray-900 hover:text-gray-700">
            mise versions
          </a>
        </div>
      </header>
      <main class="max-w-6xl mx-auto px-4 py-8">
        <Router>
          <Route path="/" component={HomePage} />
          <Route path="/:tool" component={ToolPage} />
        </Router>
      </main>
    </div>
  );
}
