// Request classification for mise clients.
//
// mise marks CI runs two ways: older releases send `x-mise-ci: true`, and
// releases after 2026.10.10 append a ` ci` token to the user agent, e.g.
// `mise/2026.10.10 linux-x64 (2026-10-11) bash ci`, which also shows up in
// Cloudflare Logpush where request headers do not. Clients with neither
// marker are not on CI. scripts/lib/logpush.js applies the same user-agent
// rule to the logs.
export function isMiseCiUserAgent(userAgent: string | null): boolean {
  return (
    !!userAgent &&
    userAgent.startsWith("mise/") &&
    /\sci$/.test(userAgent.trimEnd())
  );
}

export function isMiseCiRequest(request: Request): boolean {
  return (
    request.headers.get("x-mise-ci") === "true" ||
    isMiseCiUserAgent(request.headers.get("user-agent"))
  );
}
