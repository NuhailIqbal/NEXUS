import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import {
  CALENDAR_LIMITS, DAY_LABELS, knownTimezones, validateCalendarSettings, type CalendarSettings,
} from "./calendarTypes";

const NUMBER_FIELDS: { key: keyof typeof CALENDAR_LIMITS; label: string; unit: string; hint: string }[] = [
  { key: "slot_minutes", label: "Meeting length", unit: "minutes", hint: "How long each booking lasts by default." },
  { key: "buffer_minutes", label: "Buffer between meetings", unit: "minutes", hint: "Free time kept before and after each meeting." },
  { key: "min_notice_hours", label: "Minimum notice", unit: "hours", hint: "The agent won't book anything sooner than this." },
  { key: "max_days_ahead", label: "Booking window", unit: "days", hint: "How far ahead callers can book." },
];

export function CalendarSettingsDialog({
  open, onOpenChange, settings, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: CalendarSettings;
  onSaved: (saved: CalendarSettings) => void;
}) {
  const [form, setForm] = useState<CalendarSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Browsers often omit plain "UTC" from their zone list, and the saved zone was already validated by the
  // server — always allow both so an existing setup can be saved without touching the timezone.
  const zones = useMemo(() => Array.from(new Set(["UTC", settings.timezone, ...knownTimezones()])), [settings.timezone]);

  useEffect(() => {
    if (open) { setForm(settings); setError(null); }
  }, [open, settings]);

  const set = <K extends keyof CalendarSettings>(key: K, value: CalendarSettings[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  };
  const toggleDay = (d: number) =>
    set("work_days", form.work_days.includes(d) ? form.work_days.filter((x) => x !== d) : [...form.work_days, d].sort());

  const save = async () => {
    const problem = validateCalendarSettings(form, zones);
    if (problem) { setError(problem); return; }
    setSaving(true);
    const { data, error: err } = await api.updateCalendarSettings({ ...form });
    setSaving(false);
    if (err || !data) { setError(err || "Couldn't save your settings."); return; }
    toast.success("Calendar settings saved");
    onSaved(data as CalendarSettings);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Calendar settings</DialogTitle>
          <DialogDescription>When your agent may offer and book meetings.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cal-tz">Timezone</Label>
            <Input id="cal-tz" list="cal-tz-list" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
            <datalist id="cal-tz-list">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </div>

          <div className="space-y-1.5">
            <Label>Working days</Label>
            <div className="flex flex-wrap gap-2">
              {DAY_LABELS.map((label, d) => {
                const on = form.work_days.includes(d);
                return (
                  <button key={label} type="button" aria-pressed={on} onClick={() => toggleDay(d)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition ${on ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cal-start">Day starts</Label>
              <Input id="cal-start" type="time" value={form.start_time} onChange={(e) => set("start_time", e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cal-end">Day ends</Label>
              <Input id="cal-end" type="time" value={form.end_time} onChange={(e) => set("end_time", e.target.value)} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {NUMBER_FIELDS.map(({ key, label, unit, hint }) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`cal-${key}`}>{label} ({unit})</Label>
                <Input id={`cal-${key}`} type="number" inputMode="numeric"
                  min={CALENDAR_LIMITS[key][0]} max={CALENDAR_LIMITS[key][1]}
                  value={Number.isNaN(form[key]) ? "" : form[key]}
                  onChange={(e) => set(key, e.target.value === "" ? NaN : Number(e.target.value))} />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
