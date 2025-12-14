import { useState, useEffect } from "preact/hooks";

export function useMAU() {
  const [mau, setMAU] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/stats/mau")
      .then((res) => res.json())
      .then((data) => setMAU(data.mau))
      .catch(() => {});
  }, []);

  return mau;
}
