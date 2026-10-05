import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Loader2, Settings as SettingsIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/services/api";
import { CallbackSettingsDialog } from "@/components/callbacks/CallbackSettingsDialog";
import { RescheduleDialog } from "@/components/callbacks/RescheduleDialog";
import {
  STATUS_LABEL, SOURCE_LABEL, formatDue, isOverdue,
  type Callback, type CallbackCounts, type CallbackSettings, type CallbackStatus,
} from "@/components/callbacks/callbackTypes";
import { DAY_LABELS } from "@/components/integrations/calendarTypes";

const FILTERS: { key: CallbackStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending", label: "Scheduled" },
  { key: "called", label: "Called" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Skipped" },
  { key: "cancelled", label: "Cancelled" },
];

const STATUS_CLASS: Record<CallbackStatus, string> = {
  pending: "bg-info/15 text-info",
  calling: "bg-warning/15 text-warning",
  called: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
  skipped: "bg-muted text-muted-foreground",
};

const COLUMNS = ["Customer", "Agent", "Call back at", "Status", "What they said", "Actions"];

const hoursSummary = (s: CallbackSettings) => {
  const days = s.work_days.join() === "0,1,2,3,4" ? "Mon–Fri" : s.work_days.map((d) => DAY_LABELS[d]).join(", ");
  return `${days}, ${s.start_time}–${s.end_time} (${s.timezone})`;
};

const Callbacks = () => {
  const [rows, setRows] = useState<Callback[]>([]);
  const [counts, setCounts] = useState<CallbackCounts | null>(null);
  const [settings, setSettings] = useState<CallbackSettings | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [filter, setFilter] = useState<CallbackStatus | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rescheduling, setRescheduling] = useState<Callback | null>(null);
  const [cancelling, setCancelling] = useState<Callback | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [list, s, role] = await Promise.all([
      api.getCallbacks(filter === "all" ? undefined : filter),
      api.getCallbackSettings(),
      api.getMyRole(),
    ]);
    if (list.error || !Array.isArray(list.data)) setError(list.error || "Couldn't load your callbacks.");
    else {
      setRows(list.data as Callback[]);
      setCounts((list.meta?.counts as CallbackCounts) ?? null);
    }
    if (s.data) setSettings(s.data as CallbackSettings);
    setIsOwner((role.data as { is_owner?: boolean } | null)?.is_owner ?? true);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  const markDone = async (cb: Callback) => {
    setBusy(true);
    const { error: err } = await api.updateCallback(cb.id, { status: "called" });
    setBusy(false);
    if (err) { toast.error(err); return; }
    toast.success("Marked as called");
    load();
  };

  const confirmCancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    const { error: err } = await api.updateCallback(cancelling.id, { status: "cancelled" });
    setBusy(false);
    setCancelling(null);
    if (err) { toast.error(err); return; }
    toast.success("Callback cancelled");
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">Calls your customers asked to receive at a later time.</p>
        <Button variant="outline" onClick={() => setSettingsOpen(true)} disabled={!settings}>
          <SettingsIcon className="mr-1.5 h-4 w-4" /> Settings
        </Button>
      </div>

      {settings && (
        settings.auto_call ? (
          <div className="rounded-xl border border-success/40 bg-success/10 p-3 text-sm">
            <b>Automatic calling is on.</b> Due callbacks are placed for you, only {hoursSummary(settings)}.
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-muted/30 p-3 text-sm">
            <b>Automatic calling is off.</b> Callbacks are only recorded here; your team makes the calls.
            {isOwner && (
              <> <button className="font-medium text-primary underline underline-offset-2" onClick={() => setSettingsOpen(true)}>Turn it on in settings</button> when you are ready.</>
            )}
          </div>
        )
      )}

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter by status">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? total : counts?.[f.key] ?? 0;
          return (
            <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-sm transition ${filter === f.key ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
              {f.label} <span className="ml-1 text-xs opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">{COLUMNS.map((c) => <th key={c} className="px-4 py-3">{c}</th>)}</tr>
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
              ) : rows.length === 0 ? (
                <tr><td colSpan={COLUMNS.length} className="px-4 py-12 text-center">
                  <CalendarClock className="mx-auto h-8 w-8 text-muted-foreground" />
                  <p className="mt-2 font-medium">{filter === "all" ? "No callbacks yet" : `No ${STATUS_LABEL[filter].toLowerCase()} callbacks`}</p>
                  {filter === "all" && (
                    <p className="mx-auto mt-1 max-w-md text-muted-foreground">
                      To get them, open the <b>Events</b> tab, edit an event and tick
                      <b> Schedule a callback</b>. Then add it to your agent.
                    </p>
                  )}
                </td></tr>
              ) : (
                rows.map((cb) => {
                  const overdue = isOverdue(cb);
                  const actionable = cb.status === "pending" || cb.status === "failed" || cb.status === "skipped";
                  return (
                    <tr key={cb.id} className="divide-x divide-border border-t border-border bg-card/30">
                      <td className="px-4 py-3 text-center">
                        <div className="font-medium text-foreground">{cb.contact_name || "Unknown caller"}</div>
                        <div className="text-xs text-muted-foreground">{cb.phone || "No phone number"}</div>
                      </td>
                      <td className="px-4 py-3 text-center text-muted-foreground">{cb.agent_name || "—"}</td>
                      <td className="px-4 py-3 text-center">
                        <div className="whitespace-nowrap">{formatDue(cb.due_at, settings?.timezone || cb.timezone)}</div>
                        <div className="text-xs text-muted-foreground">{SOURCE_LABEL[cb.time_source]}</div>
                        {overdue && !settings?.auto_call && (
                          <span className="mt-1 inline-block rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">Overdue — call them</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[cb.status]}`}>{STATUS_LABEL[cb.status]}</span>
                        {cb.attempts > 0 && <div className="mt-1 text-xs text-muted-foreground">Attempts: {cb.attempts}</div>}
                        {cb.last_error && cb.status !== "called" && <div className="mx-auto mt-1 max-w-[16rem] text-xs text-muted-foreground">{cb.last_error}</div>}
                      </td>
                      <td className="px-4 py-3 text-center text-muted-foreground">
                        <div className="mx-auto max-w-[16rem] text-xs">{cb.requested_text || "—"}</div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        {actionable || cb.status === "cancelled" ? (
                          <div className="flex flex-wrap items-center justify-center gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => setRescheduling(cb)} aria-label={`Reschedule ${cb.contact_name || cb.phone || "callback"}`}>
                              Reschedule
                            </Button>
                            {actionable && (
                              <>
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => markDone(cb)} aria-label={`Mark ${cb.contact_name || cb.phone || "callback"} as called`}>
                                  Mark called
                                </Button>
                                {cb.status === "pending" && (
                                  <Button size="sm" variant="outline" disabled={busy} onClick={() => setCancelling(cb)} aria-label={`Cancel ${cb.contact_name || cb.phone || "callback"}`}>
                                    Cancel
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {settings && (
        <CallbackSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} isOwner={isOwner}
          onSaved={(s) => { setSettings(s); load(); }} />
      )}
      <RescheduleDialog callback={rescheduling} timezone={settings?.timezone} onOpenChange={(o) => !o && setRescheduling(null)} onSaved={load} />

      <AlertDialog open={!!cancelling} onOpenChange={(o) => !o && !busy && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this callback?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling?.contact_name || cancelling?.phone || "This customer"} will not be called back. You can reschedule it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); confirmCancel(); }} disabled={busy}>
              {busy ? "Cancelling…" : "Cancel callback"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default Callbacks;
