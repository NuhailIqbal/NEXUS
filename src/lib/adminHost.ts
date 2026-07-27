// Centralizes host-based branching between the admin subdomain (admin.edmnexus.ai) and the
// main app (edmnexus.ai). In production these are two different origins, so localStorage is NOT
// shared between them — any handoff between the two (e.g. impersonation) must go through a URL,
// not shared storage.

const ADMIN_PREFIX = "admin.";

/** True when the current page is being served from the admin subdomain, or the local-dev
 *  `?admin=1` override (localhost has no real subdomain to test against). */
export function isAdminHost(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.hostname.startsWith(ADMIN_PREFIX)) return true;
  return new URLSearchParams(window.location.search).get("admin") === "1";
}

/** The main app's origin, derived from the current one. On the admin subdomain this strips the
 *  "admin." prefix; anywhere else (local dev, or pre-split) it's just the current origin. */
export function mainAppOrigin(): string {
  const host = window.location.hostname;
  if (host.startsWith(ADMIN_PREFIX)) {
    return `${window.location.protocol}//${host.slice(ADMIN_PREFIX.length)}`;
  }
  return window.location.origin;
}

/** The admin subdomain's origin, derived from the current one. Used to send the browser back to
 *  the admin portal after exiting an impersonated session. */
export function adminOrigin(): string {
  const host = window.location.hostname;
  if (host.startsWith(ADMIN_PREFIX)) return window.location.origin;
  return `${window.location.protocol}//${ADMIN_PREFIX}${host}`;
}
