/**
 * Host helpers: detect the admin subdomain and derive the main-app / admin origins.
 * Browser-only (reads `window.location`). `isAdminHost` is used by App.tsx to render only the
 * Admin portal on the admin host; `mainAppOrigin` and `adminOrigin` are used by
 * src/lib/impersonation.ts to hand off between the two origins.
 */
// Centralizes host-based branching between the admin subdomain (admin.edmnexus.ai) and the
// main app (edmnexus.ai). In production these are two different origins, so localStorage is NOT
// shared between them — any handoff between the two (e.g. impersonation) must go through a URL,
// not shared storage.

/** Hostname prefix that marks the admin subdomain. */
const ADMIN_PREFIX = "admin.";

/** True when the current page is being served from the admin subdomain, or the local-dev
 *  `?admin=1` override (localhost has no real subdomain to test against). */
export function isAdminHost(): boolean {
  // No window outside the browser (e.g. a non-DOM test environment): never the admin host.
  if (typeof window === "undefined") return false;
  if (window.location.hostname.startsWith(ADMIN_PREFIX)) return true;
  return new URLSearchParams(window.location.search).get("admin") === "1";
}

/** The main app's origin, derived from the current one. On the admin subdomain this strips the
 *  "admin." prefix; anywhere else (local dev, or pre-split) it's just the current origin. */
export function mainAppOrigin(): string {
  const host = window.location.hostname;
  if (host.startsWith(ADMIN_PREFIX)) {
    // Built from `hostname`, which excludes the port, so a non-default port is not carried over.
    return `${window.location.protocol}//${host.slice(ADMIN_PREFIX.length)}`;
  }
  return window.location.origin;
}

/** The admin subdomain's origin, derived from the current one. Used to send the browser back to
 *  the admin portal after exiting an impersonated session. */
export function adminOrigin(): string {
  const host = window.location.hostname;
  if (host.startsWith(ADMIN_PREFIX)) return window.location.origin;
  // As in mainAppOrigin, `hostname` has no port, so a non-default port is not carried over.
  return `${window.location.protocol}//${ADMIN_PREFIX}${host}`;
}
