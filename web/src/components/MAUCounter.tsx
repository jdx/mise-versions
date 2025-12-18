import { useState, useEffect } from "preact/hooks";

function formatCompact(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + "m";
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(n >= 10_000 ? 1 : 2) + "k";
  }
  return n.toString();
}

export function MAUCounter() {
  const [mau, setMAU] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/stats/mau")
      .then((res) => res.json())
      .then((data) => setMAU(data.mau))
      .catch(() => {});
  }, []);

  if (mau === null || mau === 0) {
    return null;
  }

  return (
    <div class="absolute right-4 top-full z-10">
      <div class="relative bg-dark-800 border border-t-0 border-dark-600 rounded-b-lg px-3 py-1">
        {/* Heart icon hanging off bottom-left */}
        <svg
          class="absolute -bottom-2 -left-1 w-4 h-4 text-pink-500/60"
          fill="currentColor"
          viewBox="0 0 24 24"
        >
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
        </svg>
        <span class="text-xs text-gray-500">
          mise loved by {formatCompact(mau)} devs this month
        </span>
      </div>
    </div>
  );
}
