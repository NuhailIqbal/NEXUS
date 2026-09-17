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
