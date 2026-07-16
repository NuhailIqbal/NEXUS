// Admin "view as user" (impersonation) helpers.
//
// When an admin impersonates a user we swap the stored auth token for the
// user's freshly-minted token, backing up the admin's own token so it can be
// restored on exit. A full page reload is used so every query refetches as the
// impersonated user with no stale state.

const TOKEN_KEY = "nexus_token";            // must match api.ts
const RETURN_KEY = "nexus_impersonator_token";
const FLAG_KEY = "nexus_impersonating";      // holds the impersonated user's email

/** Begin impersonating: back up the current token, install the user token, reload into the dashboard. */
export function startImpersonation(token: string, email: string) {
  // Only back up the caller's token the FIRST time — if we're already
  // impersonating (e.g. admin re-entered the portal and picked another user),
  // keep the original backup so Exit still restores the real admin session.
  if (!localStorage.getItem(FLAG_KEY)) {
    localStorage.setItem(RETURN_KEY, localStorage.getItem(TOKEN_KEY) || "");
  }
  localStorage.setItem(FLAG_KEY, email);
  localStorage.setItem(TOKEN_KEY, token);
  window.location.href = "/dashboard/quick-setup";
}

/** Clear impersonation bookkeeping WITHOUT touching the auth token or redirecting.
 *  Used by sign-out / login / expiry so a stale flag never bleeds into another session. */
export function clearImpersonation() {
  localStorage.removeItem(RETURN_KEY);
  localStorage.removeItem(FLAG_KEY);
}

/** The email being impersonated, or null when not impersonating. */
export function getImpersonatedEmail(): string | null {
  return localStorage.getItem(FLAG_KEY);
}

export function isImpersonating(): boolean {
  return !!localStorage.getItem(FLAG_KEY);
}

/** End impersonation: restore the admin's token (if any) and return to the admin portal. */
export function stopImpersonation() {
  const prev = localStorage.getItem(RETURN_KEY);
  if (prev) localStorage.setItem(TOKEN_KEY, prev);
  else localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(RETURN_KEY);
  localStorage.removeItem(FLAG_KEY);
  window.location.href = "/nexus-admin";
}
