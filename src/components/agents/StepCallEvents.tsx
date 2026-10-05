import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Plus, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/services/api";
import { CallEventDialog } from "./CallEventDialog";
import { MAX_CALL_EVENTS, SCOPE_LABEL, type LibraryEvent } from "./callEventTypes";

/**
 * Wizard step: choose which events from the account's event library this agent should
 * report. `selectedIds` are library event ids. New events can be created inline.
 * Uses api.getCallEvents; `compact` hides the heading block (used in EditAIAgent).
 * Selection is capped at MAX_CALL_EVENTS.
 */
export function StepCallEvents({
  selectedIds, onChange, compact,
}: { selectedIds: string[]; onChange: (ids: string[]) => void; compact?: boolean }) {
  const [events, setEvents] = useState<LibraryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Always act on the latest selection, even if two clicks land before React re-renders.
  const latest = useRef(selectedIds);
  latest.current = selectedIds;
  /** Updates the ref immediately and notifies the parent. */
  const commit = (next: string[]) => { latest.current = next; onChange(next); };

  /** Fetches the event library and prunes selected ids that no longer exist. */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await api.getCallEvents();
    if (err || !Array.isArray(data)) {
      setError(err || "Couldn't load your events.");
      setLoading(false);
      return;
    }
    setEvents(data as LibraryEvent[]);
    setLoading(false);
    // Drop selections whose event was deleted meanwhile, so we never send a dead id.
    const known = new Set((data as LibraryEvent[]).map((e) => e.id));
    if (latest.current.some((id) => !known.has(id))) commit(latest.current.filter((id) => known.has(id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  const full = selectedIds.length >= MAX_CALL_EVENTS;
  /** Selects or deselects an event; ignores new selections once the cap is reached. */
  const toggle = (id: string, on: boolean) => {
    const cur = latest.current;
    if (on && !cur.includes(id) && cur.length >= MAX_CALL_EVENTS) return;
    commit(on ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id));
  };

  /** After inline creation, adds the event to the list and auto-selects it if there is room. */
  const handleSaved = (saved: LibraryEvent) => {
    setEvents((prev) => (prev.some((e) => e.id === saved.id) ? prev : [...prev, saved]));
    const cur = latest.current;
    if (!cur.includes(saved.id) && cur.length < MAX_CALL_EVENTS) commit([...cur, saved.id]);
  };

  return (
    <div className="space-y-6">
      {!compact && (
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Zap className="h-7 w-7" />
          </div>
          <h3 className="mt-3 text-lg font-bold">Call Events</h3>
          <p className="mt-1 text-sm text-muted-foreground">Moments your agent should report during a call</p>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Choose the events this agent should raise the instant they happen in a conversation. When the call
        ends, the last event sets the call's outcome, and all events are available to your automations.
        This step is optional.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {selectedIds.length} selected <span className="text-muted-foreground">(max {MAX_CALL_EVENTS})</span>
        </span>
        <div className="flex items-center gap-3">
          <a href="/dashboard/call-events" target="_blank" rel="noreferrer"
            className="text-sm text-primary hover:underline">Manage events</a>
          <Button type="button" variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> New event
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading your events…
        </div>
      ) : error ? (
        <div role="alert" className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <p className="text-destructive">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm font-medium">You haven't created any events yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create an event once, then reuse it on any of your agents.
          </p>
          <Button type="button" className="mt-4" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Create your first event
          </Button>
        </div>
      ) : (
        <ul className="space-y-2">
          {events.map((e) => {
            const checked = selectedIds.includes(e.id);
            return (
              <li key={e.id}>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
                    checked ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/40"
                  } ${!checked && full ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  <Checkbox
                    className="mt-0.5"
                    checked={checked}
                    disabled={!checked && full}
                    aria-label={e.label}
                    onCheckedChange={(v) => toggle(e.id, v === true)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{e.label}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {SCOPE_LABEL[e.applies_to]}
                      </span>
                      {e.schedules_callback && (
                        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">Schedules callback</span>
                      )}
                      {e.outcome && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          → {e.outcome}
                        </span>
                      )}
                    </div>
                    {e.description && <p className="mt-0.5 text-xs text-muted-foreground">{e.description}</p>}
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <CallEventDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={handleSaved} />
    </div>
  );
}
