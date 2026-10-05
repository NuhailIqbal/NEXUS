import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import { toLocalInput, type Callback } from "./callbackTypes";

/** Change when a callback should happen. The time is read in the account's timezone (falls back to the callback's own). */
export function RescheduleDialog({
  callback, timezone, onOpenChange, onSaved,
}: {
  callback: Callback | null;
  timezone?: string;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const tz = timezone || callback?.timezone || "UTC";
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (callback) {
      // Start from the current time if it is still ahead, otherwise from "now + 1 hour".
      const ahead = new Date(callback.due_at).getTime() > Date.now();
      setValue(toLocalInput(ahead ? callback.due_at : new Date(Date.now() + 3600_000).toISOString(), tz));
      setError(null);
    }
  }, [callback, tz]);

  const save = async () => {
    if (!callback) return;
    if (!value) { setError("Choose a date and time."); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await api.updateCallback(callback.id, { due_local: value });
    setSaving(false);
    if (err) { setError(err); return; }
    toast.success("Callback rescheduled");
    onSaved();
    onOpenChange(false);
  };

  return (
    <Dialog open={!!callback} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reschedule callback</DialogTitle>
          <DialogDescription>
            {callback ? `${callback.contact_name || callback.phone || "This customer"} — time is in ${tz}.` : ""}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="cb-when">Call back at</Label>
          <Input id="cb-when" type="datetime-local" value={value}
            onChange={(e) => { setValue(e.target.value); setError(null); }} />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Reschedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
