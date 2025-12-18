import { useState, useEffect } from "preact/hooks";

export function AdminButton() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/check")
      .then((res) => res.json())
      .then((data) => {
        setIsAdmin(data.isAdmin === true);
        setLoading(false);
      })
      .catch(() => {
        setIsAdmin(false);
        setLoading(false);
      });
  }, []);

  // Don't render anything while loading or if not admin
  if (loading || !isAdmin) {
    return null;
  }

  return (
    <a
      href="/admin"
      class="text-sm text-gray-400 hover:text-neon-purple transition-colors"
    >
      Admin
    </a>
  );
}
