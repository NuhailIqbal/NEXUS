/**
 * "Events" tab of the Call Events page (index route of /dashboard/call-events, rendered inside
 * CallEventsLayout). Manages the account-level event library: list, create/edit via
 * CallEventDialog, and delete. Uses api.getCallEvents and api.deleteCallEvent.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/services/api";
import { CallEventDialog } from "@/components/agents/CallEventDialog";
import { SCOPE_LABEL, syncWarningText, type LibraryEvent } from "@/components/agents/callEventTypes";

// Table headers; also used for the colSpan of the loading/error/empty rows.
const COLUMNS =["Event", "Outcome", "Applies to", "Used by", "Actions"];

/** Page component: loads the event library on mount and after every save or delete. */
const CallEvents = () => {
  const [events, setEvents] = useState<LibraryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LibraryEvent | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryEvent | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Fetches the event library, tracking loading and error state (also used by "Try again"). */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await api.getCallEvents();
    if (err || !Array.isArray(data)) setError(err || "Couldn't load your events.");
    else setEvents(data as LibraryEvent[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  /** Opens the dialog in create mode (no event). */
  const openCreate =() => { setEditing(null); setDialogOpen(true); };
  /** Opens the dialog in edit mode for the given event. */
  const openEdit =(e: LibraryEvent) => { setEditing(e); setDialogOpen(true); };

  /**
   * Deletes the pending event via api.deleteCallEvent. If the backend reports agents that could
   * not be re-synced to the voice service, shows a warning toast instead of the success toast.
   */
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    const res = await api.deleteCallEvent(pendingDelete.id);
    setDeleting(false);
    setPendingDelete(null);
    if (res.error) { toast.error(res.error); return; }
    if (res.warnings?.length) toast.warning(syncWarningText(res.warnings));
    else toast.success("Event deleted");
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Moments your agents report during calls. Create them once, then choose them on any agent.
        </p>
        <Button onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" /> New Event</Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {COLUMNS.map((c) => <th key={c} className="px-4 py-3">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={COLUMNS.length} className="px-4 py-8 text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> Loading…
                </td></tr>
              ) : error ? (
                <tr><td colSpan={COLUMNS.length} className="px-4 py-8 text-center">
                  <p role="alert" className="text-destructive">{error}</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={load}>Try again</Button>
                </td></tr>
              ) : events.length === 0 ? (
                <tr><td colSpan={COLUMNS.length} className="px-4 py-12 text-center">
                  <Zap className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="mt-2 font-medium">No events yet</p>
                  <p className="mt-1 text-muted-foreground">
                    Create an event for each moment you want your agents to report.
                  </p>
                  <Button className="mt-4" onClick={openCreate}><Plus className="mr-1.5 h-4 w-4" /> Create your first event</Button>
                </td></tr>
              ) : (
                events.map((e) => (
                  <tr key={e.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-center">
                      <div className="font-medium text-foreground">{e.label}</div>
                      {e.description && <div className="mx-auto mt-0.5 max-w-xs text-xs text-muted-foreground">{e.description}</div>}
                      {e.schedules_callback && (
                        <span className="mt-1 inline-block rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">Schedules callback</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {e.outcome ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{e.outcome}</span>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">{SCOPE_LABEL[e.applies_to]}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {e.agents?.length ? (
                        <div className="flex flex-wrap justify-center gap-1">
                          {e.agents.map((a) => (
                            <span key={a.id} className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">{a.name}</span>
                          ))}
                        </div>
                      ) : e.agent_count ? `${e.agent_count} agent${e.agent_count === 1 ? "" : "s"}` : "Not used"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => openEdit(e)} aria-label={`Edit ${e.label}`} title="Edit"
                          className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button onClick={() => setPendingDelete(e)} aria-label={`Delete ${e.label}`} title="Delete"
                          className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <CallEventDialog open={dialogOpen} onOpenChange={setDialogOpen} event={editing} onSaved={() => load()} />

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && !deleting && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDelete?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.agent_count
                ? `It will be removed from ${pendingDelete.agent_count} agent${pendingDelete.agent_count === 1 ? "" : "s"} (${(pendingDelete.agents ?? []).map((a) => a.name).join(", ")}). `
                : "No agents use it. "}
              Past calls keep their recorded events and outcomes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(ev) => { ev.preventDefault(); confirmDelete(); }} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CallEvents;
