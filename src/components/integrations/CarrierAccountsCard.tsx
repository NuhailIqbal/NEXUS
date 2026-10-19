import { useCallback, useEffect, useState } from "react";
import { PhoneCall, Trash2, Pencil, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/services/api";
import { CARRIER_KEYS, CARRIERS, carrierOf } from "@/lib/carriers";
import { IntegrationTile } from "./IntegrationTile";
import { EditCarrierAccountDialog, type CarrierAccount } from "./EditCarrierAccountDialog";

/** Connected phone-carrier accounts (Twilio / Vonage / Telnyx) — one tile per carrier in use. */
export function CarrierAccountsCard() {
  const [credentials, setCredentials] = useState<CarrierAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<CarrierAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editTarget, setEditTarget] = useState<CarrierAccount | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await api.getTwilioCredentials();
    if (error) toast.error(error);
    setCredentials((data as CarrierAccount[]) ?? []);
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
    toast.success(`${carrierOf(deleteTarget.carrier).label} account removed`);
    setDeleteTarget(null);
    load();
  };

  // Like every other integration, this only shows up once at least one account has
  // been connected (via Add Integration) — nothing to manage yet, nothing to show.
  if (loading || credentials.length === 0) return null;

  const deleteDef = carrierOf(deleteTarget?.carrier);

  return (
    <>
      {CARRIER_KEYS.map((key) => {
        const accounts = credentials.filter((c) => carrierOf(c.carrier).key === key);
        if (accounts.length === 0) return null;
        return (
          <IntegrationTile
            key={key}
            icon={PhoneCall}
            title={CARRIERS[key].label}
            badge={
              <Badge variant="outline" className="shrink-0 gap-1 border-success/40 bg-success/10 text-success">
                <CheckCircle2 className="h-3 w-3" /> Connected
              </Badge>
            }
          >
            <div className="space-y-2">
              {accounts.map((c) => {
                const heading = c.label || c.account_sid || `${CARRIERS[key].label} account`;
                return (
                  <div key={c.id} className="flex items-center justify-between rounded-lg border border-border bg-muted/30 p-2.5">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">{heading}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {/* Don't repeat the identifier when it's already the title (no label set). */}
                        {c.label && c.account_sid ? c.account_sid : ""}
                        {c.auth_token_masked ? `${c.label && c.account_sid ? " · " : ""}${c.auth_token_masked}` : ""}
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
                );
              })}
            </div>
          </IntegrationTile>
        );
      })}

      <EditCarrierAccountDialog target={editTarget} onOpenChange={(o) => !o && setEditTarget(null)} onSaved={load} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this {deleteDef.label} account?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.label || deleteTarget?.account_sid || `This ${deleteDef.label} account`} will be
              disconnected. This is blocked while any phone number still uses it.
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
