/**
 * "Viewing as <email> (admin)" pill for admin impersonation sessions. Rendered by DashboardLayout.
 * The impersonated email comes from localStorage via lib/impersonation (the flag is set by
 * AuthContext when it consumes the impersonation token from the URL); no API calls are made here.
 */
import { Eye } from "lucide-react";
import { getImpersonatedEmail, stopImpersonation } from "@/lib/impersonation";

// Floating pill shown whenever an admin is viewing the app as a user.
// Fixed-position so it never shifts the dashboard layout.
/**
 * Renders nothing in a normal session. The "Exit admin view" button calls stopImpersonation(),
 * which removes the stored auth token and impersonation flag and does a full-page redirect to the
 * admin portal, so there is no React state to reset here.
 */
export default function ImpersonationBanner() {
  // Plain localStorage read on each render, not a subscription: the flag is set once on page load
  // (AuthContext) and cleared either by sign-out or by the full-page redirect described above.
  const email = getImpersonatedEmail();
  if (!email) return null;

  return (
    <div className="fixed inset-x-4 bottom-4 z-[60] mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center justify-center gap-2 rounded-full border border-amber-600 bg-amber-500 px-3 py-2 text-xs font-medium text-black shadow-lg sm:gap-3 sm:px-4 sm:text-sm">
      <Eye className="h-4 w-4 shrink-0" />
      <span className="min-w-0 break-words">
        Viewing as <strong className="break-all">{email}</strong> <span className="opacity-70">(admin)</span>
      </span>
      <button
        onClick={stopImpersonation}
        className="shrink-0 rounded-full bg-black/20 px-3 py-0.5 text-xs font-semibold transition hover:bg-black/30"
      >
        Exit admin view
      </button>
    </div>
  );
}
