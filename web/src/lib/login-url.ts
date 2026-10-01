// Where to send a visitor to sign in, returning them to the page they are on.
export function loginUrl(): string {
  const here =
    typeof window === "undefined"
      ? "/"
      : window.location.pathname + window.location.search;
  return `/api/auth/login?return_to=${encodeURIComponent(here)}`;
}
