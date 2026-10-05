import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";
import {
  MAX_DESCRIPTION, MAX_LABEL, MAX_OUTCOME, SCOPE_LABEL, syncWarningText,
  type CallEventScope, type LibraryEvent,
} from "./callEventTypes";

/** Create a library event, or edit one when `event` is given. */
export function CallEventDialog({
  open, onOpenChange, event, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event?: LibraryEvent | null;
  onSaved: (saved: LibraryEvent) => void;
}) {
  const editing = !!event;
  const [label, setLabel] = useState("");
  const [outcome, setOutcome] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<CallEventScope>("both");
  const [schedulesCallback, setSchedulesCallback] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Editing any field clears a stale error message.
  const field = <T,>(set: (v: T) => void) => (v: T) => { set(v); setError(null); };

  // Reset the form each time the dialog opens (for a new event, or a different one).
  useEffect(() => {
    if (!open) return;
    setLabel(event?.label ?? "");
    setOutcome(event?.outcome ?? "");
    setDescription(event?.description ?? "");
    setScope(event?.applies_to ?? "both");
    setSchedulesCallback(!!event?.schedules_callback);
    setError(null);
  }, [open, event]);

  const save = async () => {
    if (!label.trim()) { setError("Enter an event name."); return; }
    setSaving(true);
    setError(null);
    const payload = {
      label: label.trim(),
      outcome: outcome.trim() || null,
      description: description.trim() || null,
      applies_to: scope,
      schedules_callback: schedulesCallback,
    };
    const res = editing
      ? await api.updateCallEvent(event!.id, payload)
      : await api.createCallEvent(payload);
    setSaving(false);
    if (res.error || !res.data) {
      setError(res.error || "Couldn't save the event.");
      return;
    }
    if (res.warnings?.length) toast.warning(syncWarningText(res.warnings));
    else toast.success(editing ? "Event updated" : "Event created");
    onSaved({ ...(event ?? {}), ...(res.data as LibraryEvent) });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit event" : "New call event"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes apply to every agent that uses this event."
              : "Define it once, then choose it on any agent."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ce-label">Event name</Label>
            <Input id="ce-label" value={label} maxLength={MAX_LABEL} placeholder="Name this event"
              onChange={(e) => field(setLabel)(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ce-outcome">Outcome value</Label>
            <Input id="ce-outcome" value={outcome} maxLength={MAX_OUTCOME} placeholder="Defaults to the event name"
              onChange={(e) => field(setOutcome)(e.target.value)} />
            <p className="text-xs text-muted-foreground">Shown on the call when this is the last event raised.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ce-desc">When should the agent raise it?</Label>
            <Input id="ce-desc" value={description} maxLength={MAX_DESCRIPTION}
              placeholder="Describe when the agent should raise this event"
              onChange={(e) => field(setDescription)(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Applies to</Label>
            <Select value={scope} onValueChange={(v) => field(setScope)(v as CallEventScope)}>
              <SelectTrigger aria-label="Applies to"><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(SCOPE_LABEL) as CallEventScope[]).map((k) => (
                  <SelectItem key={k} value={k}>{SCOPE_LABEL[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Use "Inbound only" or "Outbound only" when the same agent handles both kinds of calls.
            </p>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-input p-3">
            <Checkbox className="mt-0.5" checked={schedulesCallback} aria-label="Schedule a callback"
              onCheckedChange={(v) => field(setSchedulesCallback)(v === true)} />
            <span className="text-sm">
              <span className="block font-medium">Schedule a callback when this happens</span>
              <span className="block text-xs text-muted-foreground">
                Use this when the event means the caller wants to be contacted again. If the caller names a day or
                time, or how long to wait (such as "in 30 minutes"), the agent passes it along and a callback is
                recorded in the Callbacks tab.
              </span>
            </span>
          </label>
          {editing && (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              Renaming only changes the display name. Past calls keep their recorded events.
            </p>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {editing ? "Save changes" : "Create event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
