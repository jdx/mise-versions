import { useState, useRef, useEffect } from "preact/hooks";

const MAX_SUGGESTIONS = 8;

interface Suggestion {
  name: string;
  description?: string;
}

function getInitialQuery(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("q") || "";
}

export function NavSearch() {
  const [query, setQuery] = useState(getInitialQuery);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const debounceRef = useRef<number>();
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchSuggestions = async (q: string) => {
    if (!q.trim()) {
      setSuggestions([]);
      return;
    }
    try {
      const res = await fetch(`/api/tools?q=${encodeURIComponent(q.trim())}`);
      if (!res.ok) return;
      const data = await res.json();
      setSuggestions((data.tools || []).slice(0, MAX_SUGGESTIONS));
    } catch (e) {
      console.error("Failed to fetch search suggestions:", e);
    }
  };

  const handleInput = (value: string) => {
    setQuery(value);
    setShowSuggestions(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => fetchSuggestions(value), 300);
  };

  // Auto-select first suggestion when the list changes
  useEffect(() => {
    setSelectedIndex(suggestions.length > 0 ? 0 : -1);
  }, [suggestions]);

  const goToTool = (name: string) => {
    window.location.href = `/tools/${name}`;
  };

  const goToResults = () => {
    const q = query.trim();
    if (!q) return;
    window.location.href = `/?q=${encodeURIComponent(q)}`;
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setShowSuggestions(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (
        showSuggestions &&
        selectedIndex >= 0 &&
        selectedIndex < suggestions.length
      ) {
        goToTool(suggestions[selectedIndex].name);
      } else {
        goToResults();
      }
      return;
    }
    if (!showSuggestions || suggestions.length === 0) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % suggestions.length);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIndex(
          (prev) => (prev - 1 + suggestions.length) % suggestions.length,
        );
        break;
    }
  };

  return (
    <div class="relative w-40 sm:w-56 md:w-64">
      <input
        ref={inputRef}
        type="text"
        placeholder="Search tools..."
        value={query}
        onInput={(e) => handleInput((e.target as HTMLInputElement).value)}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        onKeyDown={handleKeyDown}
        class="w-full px-3 py-1.5 bg-dark-900 border border-dark-600 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-neon-purple focus:ring-1 focus:ring-neon-purple"
        autocomplete="off"
      />
      {showSuggestions && suggestions.length > 0 && (
        <div class="absolute z-50 w-full mt-1 bg-dark-800 border border-dark-600 rounded-lg shadow-lg overflow-hidden">
          {suggestions.map((tool, index) => (
            <button
              key={tool.name}
              type="button"
              onMouseDown={() => goToTool(tool.name)}
              class={`w-full px-3 py-2 text-left text-sm transition-colors ${
                index === selectedIndex
                  ? "bg-neon-purple/20 text-neon-purple"
                  : "text-gray-300 hover:bg-dark-700"
              }`}
            >
              {tool.name}
              {tool.description && (
                <span class="ml-2 text-xs text-gray-500">
                  {tool.description.slice(0, 40)}
                  {tool.description.length > 40 ? "..." : ""}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
