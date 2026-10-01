import { useCallback, useEffect, useState } from "react";
import { PhoneCall, Trash2, Pencil, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/services/api";
import { IntegrationTile } from "./IntegrationTile";
import { EditTwilioAccountDialog } from "./EditTwilioAccountDialog";

type TwilioCredential = {
  id: string;
  account_sid: string;
  label?: string | null;
  auth_token_masked?: string;
};

export function TwilioByotCard() {
  const [credentials, setCredentials] = useState<TwilioCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<TwilioCredential | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTarget, setEditTarget] = useState<TwilioCredential | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await api.getTwilioCredentials();
    if (error) toast.error(error);
    setCredentials((data as TwilioCredential[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await api.deleteTwilioCredential(deleteTarget.id);
    setDeleting(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Twilio account removed");
    setDeleteTarget(null);
    load();
  };

  // Like every other integration, this only shows up once at least one account has
  // been connected (via Add Integration) — nothing to manage yet, nothing to show.
  if (loading || credentials.length === 0) return null;

  return (
    <>
      <IntegrationTile
        icon={PhoneCall}
        title="Twilio"
        badge={
          <Badge variant="outline" className="shrink-0 gap-1 border-success/40 bg-success/10 text-success">
            <CheckCircle2 className="h-3 w-3" /> Connected
          </Badge>
        }
      >
        <div className="space-y-2">
          {credentials.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-2.5">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">{c.label || c.account_sid}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {/* Don't repeat the SID when it's already the title (no label set). */}
                  {c.label ? c.account_sid : ""}
                  {c.auth_token_masked ? `${c.label ? " · " : ""}${c.auth_token_masked}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  onClick={() => setEditTarget(c)}
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground sm:p-1.5"
                  aria-label="Edit"
                  title="Edit"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setDeleteTarget(c)}
                  className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-destructive sm:p-1.5"
                  aria-label="Remove"
                  title="Remove"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </IntegrationTile>

      <EditTwilioAccountDialog target={editTarget} onOpenChange={(o) => !o && setEditTarget(null)} onSaved={load} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this Twilio account?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.label || deleteTarget?.account_sid} will be disconnected. This is blocked while any
              phone number still uses it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmDelete(); }} disabled={deleting}>
              {deleting ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
