import { useState, useEffect } from "preact/hooks";

export function AdminButton() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/check")
      .then((res) => res.json<{ isAdmin?: boolean }>())
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
    <a href="/admin" class="site-menu-item">
      Admin dashboard
    </a>
  );
}
