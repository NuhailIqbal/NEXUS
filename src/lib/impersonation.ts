// Admin "view as user" (impersonation) helpers.
//
// The admin portal (admin.edmnexus.ai) and the main app (edmnexus.ai) are different origins in
// production, so localStorage is NOT shared between them. Starting an impersonated session hands
// the token to the main app via a URL (read once on load by AuthContext, then stripped from the
// address bar) instead of writing directly into localStorage from the admin origin. Exiting just
// clears the dashboard's own impersonation state and sends the browser back to the admin origin —
// the admin's own session was never touched, so there's nothing to restore.

import { mainAppOrigin, adminOrigin } from "@/lib/adminHost";

const TOKEN_KEY = "nexus_token";            // must match api.ts
const FLAG_KEY = "nexus_impersonating";      // holds the impersonated user's email

function impersonationUrl(token: string, email: string): string {
  const params = new URLSearchParams({ impersonate_token: token, impersonate_email: email });
  return `${mainAppOrigin()}/dashboard/quick-setup?${params.toString()}`;
}

/** Begin impersonating in a given window/tab (used for the "open in new tab" flow). */
export function openImpersonation(w: Window, token: string, email: string) {
  w.location.href = impersonationUrl(token, email);
}

/** Begin impersonating in the CURRENT tab (fallback when a new tab is blocked). */
export function startImpersonation(token: string, email: string) {
  window.location.href = impersonationUrl(token, email);
}

/** Called by AuthContext on mount when it finds `impersonate_token` in the URL. */
export function markImpersonating(email: string) {
  localStorage.setItem(FLAG_KEY, email);
}

/** Clear impersonation bookkeeping WITHOUT touching the auth token or redirecting.
 *  Used by sign-out / login / expiry so a stale flag never bleeds into another session. */
export function clearImpersonation() {
  localStorage.removeItem(FLAG_KEY);
}

/** The email being impersonated, or null when not impersonating. */
export function getImpersonatedEmail(): string | null {
  return localStorage.getItem(FLAG_KEY);
}

export function isImpersonating(): boolean {
  return !!localStorage.getItem(FLAG_KEY);
}

/** End impersonation: log out of the impersonated dashboard session and return to the admin
 *  portal. The admin's own session lives entirely on the admin origin and was never disturbed. */
export function stopImpersonation() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(FLAG_KEY);
  window.location.href = adminOrigin();
}
