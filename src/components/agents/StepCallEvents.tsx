import { Plus, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

export type CallEventForm = {
  label: string;
  description: string;
  outcome: string;
};

/** A saved call event as returned by GET /agents/:id/events. */
export type SavedCallEvent = { label: string | null; description: string | null; outcome: string | null };

export const MAX_CALL_EVENTS = 20;
export const MAX_LABEL = 60;
export const MAX_OUTCOME = 60;
export const MAX_DESCRIPTION = 200;

/** Drops half-filled rows and shapes call events for the agents API. */
export const toCallEventsPayload = (events: CallEventForm[]) =>
  events
    .filter((e) => e.label.trim())
    .map((e) => ({
      label: e.label.trim(),
      description: e.description.trim() || null,
      outcome: e.outcome.trim() || null,
    }));

const TEMPLATES: CallEventForm[] = [
  { label: "Interested", description: "The caller shows interest in the product or offer", outcome: "Interested" },
  { label: "Callback Requested", description: "The caller asks to be called back later", outcome: "Callback" },
  { label: "Not Interested", description: "The caller clearly says they are not interested", outcome: "Not Interested" },
  { label: "Do Not Call", description: "The caller asks not to be contacted again", outcome: "Do Not Call" },
  { label: "Wrong Number", description: "The person says this is the wrong number or wrong person", outcome: "Wrong Number" },
  { label: "Appointment Booked", description: "The caller agrees to a specific appointment or meeting", outcome: "Appointment Booked" },
];

const inputCls =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30";

export function StepCallEvents({
  events, onChange, compact,
}: { events: CallEventForm[]; onChange: (next: CallEventForm[]) => void; compact?: boolean }) {
  const has = (label: string) => events.some((e) => e.label.trim().toLowerCase() === label.toLowerCase());
  const full = events.length >= MAX_CALL_EVENTS;

  const patch = (i: number, p: Partial<CallEventForm>) =>
    onChange(events.map((e, idx) => (idx === i ? { ...e, ...p } : e)));

  return (
    <div className="space-y-6">
      {!compact && (
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Zap className="h-7 w-7" />
          </div>
          <h3 className="mt-3 text-lg font-bold">Call Events</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Moments your agent should report during a call
          </p>
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        The agent raises an event the instant it happens in the conversation. When the call ends, the
        last event sets the call's outcome, and all events are available to your automations.
        This step is optional.
      </p>

      <div className="flex flex-wrap gap-2">
        {TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            disabled={has(t.label) || full}
            onClick={() => onChange([...events, t])}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium transition hover:bg-muted disabled:opacity-40"
          >
            + {t.label}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {events.map((e, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-border bg-muted/20 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium">Event name</label>
                <input
                  value={e.label}
                  onChange={(ev) => patch(i, { label: ev.target.value })}
                  placeholder="Callback Requested"
                  maxLength={MAX_LABEL}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium">Outcome value</label>
                <input
                  value={e.outcome}
                  onChange={(ev) => patch(i, { outcome: ev.target.value })}
                  placeholder="Callback"
                  maxLength={MAX_OUTCOME}
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium">When should the agent raise it?</label>
              <div className="flex gap-2">
                <input
                  value={e.description}
                  onChange={(ev) => patch(i, { description: ev.target.value })}
                  placeholder="The caller asks to be called back later"
                  maxLength={MAX_DESCRIPTION}
                  className={inputCls}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Remove event"
                  onClick={() => onChange(events.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        disabled={full}
        onClick={() => onChange([...events, { label: "", description: "", outcome: "" }])}
      >
        <Plus className="mr-1.5 h-4 w-4" /> Add custom event
      </Button>
    </div>
  );
}
