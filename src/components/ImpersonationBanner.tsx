import { Eye } from "lucide-react";
import { getImpersonatedEmail, stopImpersonation } from "@/lib/impersonation";

// Floating pill shown whenever an admin is viewing the app as a user.
// Fixed-position so it never shifts the dashboard layout.
export default function ImpersonationBanner() {
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
