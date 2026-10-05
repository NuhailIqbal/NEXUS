/**
 * Read-only notice for Viewer-role team members, rendered at the top of the dashboard <main>
 * (DashboardLayout). Calls GET /team/me once on mount via api.getMyRole and renders nothing
 * for owners and members. Purely informational: write requests from viewers are rejected
 * by the backend's team-role middleware (403) regardless of what the UI shows.
 */
import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { api } from "@/services/api";

/**
 * Persistent notice for Viewer-role team members: read-only access, so they
 * understand up front why create/edit actions will be rejected.
 */
const ViewerBanner = () => {
  const [isViewer, setIsViewer] = useState(false);

  useEffect(() => {
    // `on` drops the response if the component unmounted before the request finished. The flag
    // is only ever set to true here; role changes mid-session are handled by DashboardLayout's poll.
    let on = true;
    api.getMyRole().then(({ data }) => {
      if (on && data && !data.is_owner && data.role === "viewer") setIsViewer(true);
    });
    return () => { on = false; };
  }, []);

  if (!isViewer) return null;

  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
      <Eye className="h-4 w-4 shrink-0" />
      <span>You have read-only (Viewer) access on this account. Creating, editing, and deleting are disabled.</span>
    </div>
  );
};

export default ViewerBanner;
