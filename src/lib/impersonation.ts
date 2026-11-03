/**
 * Client-side bookkeeping for admin "view as user" sessions. The token itself comes from the
 * backend (POST /admin/users/{id}/impersonate, called in pages/dashboard/Admin.tsx, which then
 * uses `openImpersonation` / `startImpersonation`). `markImpersonating` and `clearImpersonation`
 * are used by contexts/AuthContext.tsx; `getImpersonatedEmail` and `stopImpersonation` by
 * components/ImpersonationBanner.tsx. A referral partner viewing as one of their users goes through
 * `startPartnerImpersonation` instead (same origin, so the token is swapped in place and parked for the exit).
 */
// Admin "view as user" (impersonation) helpers.
//
// The admin portal (admin.edmnexus.ai) and the main app (edmnexus.ai) are different origins in
// production, so localStorage is NOT shared between them. Starting an impersonated session hands
// the token to the main app via a URL (read once on load by AuthContext, then stripped from the
// address bar) instead of writing directly into localStorage from the admin origin. Exiting just
// clears the dashboard's own impersonation state and sends the browser back to the admin origin —
// the admin's own session was never touched, so there's nothing to restore.

import { mainAppOrigin, adminOrigin } from "@/lib/adminHost";

/** localStorage key of the dashboard session token. */
const TOKEN_KEY = "nexus_token";            // must match api.ts
/** localStorage key whose presence marks the current session as an impersonation. */
const FLAG_KEY = "nexus_impersonating";      // holds the impersonated user's email
/** Set only while a referral PARTNER is viewing as one of their users: holds the partner's own token so exiting restores it. */
const PARTNER_RETURN_KEY = "nexus_partner_return_token";

/**
 * Builds the main-app URL that carries the impersonation token and email as query params
 * (the cross-origin handoff); AuthContext consumes and strips them on load. The landing
 * page is /dashboard.
 */
function impersonationUrl(token: string, email: string): string {
  const params = new URLSearchParams({ impersonate_token: token, impersonate_email: email });
  return `${mainAppOrigin()}/dashboard?${params.toString()}`;
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
  localStorage.removeItem(PARTNER_RETURN_KEY);
}

/** The email being impersonated, or null when not impersonating. */
export function getImpersonatedEmail(): string | null {
  return localStorage.getItem(FLAG_KEY);
}

/** True when an impersonation flag is set in localStorage. */
export function isImpersonating(): boolean {
  return !!localStorage.getItem(FLAG_KEY);
}

/** True when the current impersonation was started by a referral partner (not an admin). */
export function isPartnerImpersonation(): boolean {
  return isImpersonating() && !!localStorage.getItem(PARTNER_RETURN_KEY);
}

/**
 * A referral partner starts viewing as one of their referred users, in the CURRENT tab. Unlike the admin flow
 * the partner and the dashboard share one origin, hence one localStorage, so the partner's own token is parked
 * under PARTNER_RETURN_KEY and swapped back by stopImpersonation(). (Other open tabs of the same browser follow
 * the swap, as they all read the same token.)
 */
export function startPartnerImpersonation(token: string, email: string) {
  // Keep the partner's own token across a second "view as" without ever parking an impersonation token as theirs.
  const own = localStorage.getItem(TOKEN_KEY);
  if (own && !localStorage.getItem(FLAG_KEY)) localStorage.setItem(PARTNER_RETURN_KEY, own);
  localStorage.setItem(TOKEN_KEY, token);
  markImpersonating(email);
  window.location.href = "/dashboard";
}

/** End impersonation. An admin's session is dropped and the browser returns to the admin portal (whose own
 *  session was never disturbed). A partner's own token is restored and they land back on their Partner page. */
export function stopImpersonation() {
  const partnerToken = localStorage.getItem(PARTNER_RETURN_KEY);
  localStorage.removeItem(FLAG_KEY);
  localStorage.removeItem(PARTNER_RETURN_KEY);
  if (partnerToken) {
    localStorage.setItem(TOKEN_KEY, partnerToken);
    window.location.href = "/dashboard/partner";
    return;
  }
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = adminOrigin();
}
