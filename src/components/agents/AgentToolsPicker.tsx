/**
 * Checklist of tool presets an agent may use during a call. Loads presets with
 * api.getToolPresets and, when a calendar tool is selected, the calendar connection state with
 * api.getCalendarStatus. Used in the agent create wizard (CreateAIAgent).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import type { CalendarStatus } from "@/components/integrations/calendarTypes";

/** A selectable tool preset from the server; `requires` names a prerequisite such as an integration. */
export type ToolPreset = { key: string; label: string; description: string; requires: string | null };

// Preset keys that need a connected calendar to work.
const CALENDAR_TOOLS =["check_availability", "book_slot"];

/**
 * "What can this agent do during a call?" — a checklist of the server's tool presets
 * (SMS, email, calendar...). `selectedKeys` are preset keys, saved as `selected_tool_keys`.
 * Warns when a calendar tool is chosen but no calendar is connected yet.
 */
export function AgentToolsPicker({
  selectedKeys, onChange,
}: { selectedKeys: string[]; onChange: (keys: string[]) => void }) {
  const [presets, setPresets] = useState<ToolPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null);

  // Act on the latest selection even if two clicks land before React re-renders.
  const latest = useRef(selectedKeys);
  latest.current = selectedKeys;

  /** Fetches the tool presets, tracking loading and error state (also used by "Try again"). */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await api.getToolPresets();
    if (err || !Array.isArray(data)) setError(err || "Couldn't load the available tools.");
    else setPresets(data as ToolPreset[]);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Calendar status is fetched lazily, only once a calendar tool is first selected.
  const wantsCalendar =selectedKeys.some((k) => CALENDAR_TOOLS.includes(k));
  useEffect(() => {
    if (!wantsCalendar || calendar) return;
    api.getCalendarStatus().then(({ data }) => { if (data) setCalendar(data as CalendarStatus); });
  }, [wantsCalendar, calendar]);

  /** Adds or removes a preset key and reports the new list through onChange. */
  const toggle = (key: string, on: boolean) => {
    const next = on ? [...latest.current.filter((k) => k !== key), key] : latest.current.filter((k) => k !== key);
    latest.current = next;
    onChange(next);
  };

  const calendarProblem =
    wantsCalendar && calendar
      ? !calendar.connected
        ? "No calendar is connected yet, so these tools won't be able to check or book times until you connect one."
        : calendar.status === "reauth_required"
        ? "Your calendar connection needs to be reconnected before these tools will work."
        : null
      : null;

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading tools…</div>;
  }
  if (error) {
    return (
      <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
        <p className="text-destructive">{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={load}>Try again</Button>
      </div>
    );
  }
  if (presets.length === 0) return <p className="text-sm text-muted-foreground">No tools are available.</p>;

  return (
    <div className="space-y-3">
      <ul className="space-y-2">
        {presets.map((p) => {
          const checked = selectedKeys.includes(p.key);
          return (
            <li key={p.key}>
              <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition ${checked ? "border-primary/40 bg-primary/5" : "border-input hover:bg-muted/40"}`}>
                <Checkbox className="mt-0.5" checked={checked} aria-label={p.label}
                  onCheckedChange={(v) => toggle(p.key, v === true)} />
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{p.label}</span>
                  <span className="block text-xs text-muted-foreground">{p.description}</span>
                  {p.requires && <span className="mt-0.5 block text-xs text-muted-foreground/80">Needs {p.requires}</span>}
                </div>
              </label>
            </li>
          );
        })}
      </ul>

      {selectedKeys.includes("book_slot") && !selectedKeys.includes("check_availability") && (
        <p className="text-xs text-muted-foreground">
          Tip: also tick “Check Availability” — without it the agent has no way to find free times to book.
        </p>
      )}
      {calendarProblem && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <p>
            {calendarProblem}{" "}
            <a href="/dashboard/integrations" target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">
              Open Integrations
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
