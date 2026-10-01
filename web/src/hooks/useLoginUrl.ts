import { useEffect, useState } from "preact/hooks";
import { loginUrl } from "../lib/login-url";

// The page to return to is only known in the browser, after hydration, so
// server-rendered HTML carries the plain login URL until then.
export function useLoginUrl(): string {
  const [href, setHref] = useState("/api/auth/login");
  useEffect(() => setHref(loginUrl()), []);
  return href;
}
