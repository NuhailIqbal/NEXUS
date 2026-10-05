import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { TimezoneSelect } from "@/components/common/TimezoneSelect";
import { TimeSelect } from "@/components/common/TimeSelect";
import { api } from "@/services/api";
import { DAY_LABELS, knownTimezones } from "@/components/integrations/calendarTypes";
import { validateCallbackSettings, type CallbackSettings } from "./callbackTypes";

export function CallbackSettingsDialog({
  open, onOpenChange, settings, isOwner, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: CallbackSettings;
  isOwner: boolean;
  onSaved: (saved: CallbackSettings) => void;
}) {
  const [form, setForm] = useState<CallbackSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const zones = useMemo(() => Array.from(new Set(["UTC", settings.timezone, ...knownTimezones()])), [settings.timezone]);

  useEffect(() => {
    if (open) { setForm(settings); setError(null); setConfirmAuto(false); }
  }, [open, settings]);

  const set = <K extends keyof CallbackSettings>(key: K, value: CallbackSettings[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };
  const toggleDay = (d: number) =>
    set("work_days", form.work_days.includes(d) ? form.work_days.filter((x) => x !== d) : [...form.work_days, d].sort());

  const persist = async () => {
    setSaving(true);
    const { data, error: err } = await api.updateCallbackSettings({ ...form });
    setSaving(false);
    setConfirmAuto(false);
    if (err || !data) { setError(err || "Couldn't save your settings."); return; }
    toast.success("Callback settings saved");
    onSaved(data as CallbackSettings);
    onOpenChange(false);
  };

  const save = () => {
    const problem = validateCallbackSettings(form, zones);
    if (problem) { setError(problem); return; }
    // Turning automatic calling ON spends money, so ask once, plainly.
    if (form.auto_call && !settings.auto_call) { setConfirmAuto(true); return; }
    persist();
  };

  const num = (key: "retry_minutes" | "max_attempts", label: string, hint: string, lo: number, hi: number) => (
    <div className="space-y-1.5">
      <Label htmlFor={`cbs-${key}`}>{label}</Label>
      <Input id={`cbs-${key}`} type="number" inputMode="numeric" min={lo} max={hi} disabled={!isOwner}
        value={Number.isNaN(form[key]) ? "" : form[key]}
        onChange={(e) => set(key, e.target.value === "" ? NaN : Number(e.target.value))} />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Callback settings</DialogTitle>
            <DialogDescription>When callbacks may be placed, and whether NEXUS places them for you.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-md border border-input p-3">
              <div>
                <Label htmlFor="cbs-auto" className="text-sm font-medium">Place callbacks automatically</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Off: callbacks are only recorded here and your team calls them. On: NEXUS calls the customer at the
                  time they asked for, inside your calling hours. Each call uses your wallet balance.
                </p>
              </div>
              <Switch id="cbs-auto" aria-label="Place callbacks automatically" checked={form.auto_call} disabled={!isOwner}
                onCheckedChange={(v) => set("auto_call", v)} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cbs-tz">Timezone</Label>
              <TimezoneSelect id="cbs-tz" value={form.timezone} zones={zones} disabled={!isOwner} onChange={(tz) => set("timezone", tz)} />
              <p className="text-xs text-muted-foreground">Everything here follows this timezone: your calling days and hours, the default time, and any day or time a caller asks for.</p>
            </div>

            <div className="space-y-1.5">
              <Label>Calling days</Label>
              <div className="flex flex-wrap gap-2">
                {DAY_LABELS.map((label, d) => {
                  const on = form.work_days.includes(d);
                  return (
                    <button key={label} type="button" aria-pressed={on} disabled={!isOwner} onClick={() => toggleDay(d)}
                      className={`rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-60 ${on ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="cbs-start">Calls start</Label>
                <TimeSelect id="cbs-start" value={form.start_time} disabled={!isOwner} onChange={(v) => set("start_time", v)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cbs-end">Calls stop</Label>
                <TimeSelect id="cbs-end" value={form.end_time} disabled={!isOwner} onChange={(v) => set("end_time", v)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cbs-default">Default time</Label>
                <TimeSelect id="cbs-default" value={form.default_time} disabled={!isOwner} onChange={(v) => set("default_time", v)} />
              </div>
            </div>
            <p className="-mt-2 text-xs text-muted-foreground">
              The default time is used when a callback is requested without a time (next calling day).
            </p>

            <div className="grid gap-3 sm:grid-cols-2">
              {num("retry_minutes", "Retry after (minutes)", "If placing the call fails.", 5, 1440)}
              {num("max_attempts", "Attempts", "How many times to try before giving up.", 1, 5)}
            </div>

            {!isOwner && <p className="text-sm text-muted-foreground">Only the account owner can change these settings.</p>}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{isOwner ? "Cancel" : "Close"}</Button>
            {isOwner && (
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save settings
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmAuto} onOpenChange={(o) => !o && !saving && setConfirmAuto(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on automatic callbacks?</AlertDialogTitle>
            <AlertDialogDescription>
              NEXUS will place real phone calls to customers at the time they asked for, only inside your calling hours,
              never to numbers on a do-not-call list, and each call uses your wallet balance. Callbacks that are already
              due will be placed within a minute. You can turn this off at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Not yet</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); persist(); }} disabled={saving}>
              {saving ? "Turning on…" : "Turn on"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
