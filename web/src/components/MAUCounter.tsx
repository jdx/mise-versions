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
      <div class="bg-dark-700/90 backdrop-blur-sm border border-t-0 border-dark-600 rounded-b-lg px-3 py-1">
        <span class="text-xs text-gray-500">
          mise loved by {formatCompact(mau)} devs this month
        </span>
      </div>
    </div>
  );
}
