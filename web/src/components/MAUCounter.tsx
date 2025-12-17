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
    <span class="text-sm text-gray-400">
      mise loved by {formatCompact(mau)} devs this month
    </span>
  );
}
