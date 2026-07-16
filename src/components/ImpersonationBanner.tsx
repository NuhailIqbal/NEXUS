import { Eye } from "lucide-react";
import { getImpersonatedEmail, stopImpersonation } from "@/lib/impersonation";

// Floating pill shown whenever an admin is viewing the app as a user.
// Fixed-position so it never shifts the dashboard layout.
export default function ImpersonationBanner() {
  const email = getImpersonatedEmail();
  if (!email) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full border border-amber-600 bg-amber-500 px-4 py-2 text-sm font-medium text-black shadow-lg">
      <Eye className="h-4 w-4 shrink-0" />
      <span>
        Viewing as <strong>{email}</strong> <span className="opacity-70">(admin)</span>
      </span>
      <button
        onClick={stopImpersonation}
        className="rounded-full bg-black/20 px-3 py-0.5 text-xs font-semibold transition hover:bg-black/30"
      >
        Exit admin view
      </button>
    </div>
  );
}
