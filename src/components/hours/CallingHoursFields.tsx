/**
 * The calling-hours form shared by outbound campaigns and AI receptionists: an on/off switch and,
 * while it is on, timezone, days and start/end times. The pickers and their layout are the ones in
 * the Callbacks settings (TimezoneSelect, day buttons, TimeSelect), so all three read the same.
 * Controlled: the parent owns the CallingHours value and saves it. No API calls.
 */
import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TimeSelect } from "@/components/common/TimeSelect";
import { TimezoneSelect } from "@/components/common/TimezoneSelect";
import { COMMON_TIMEZONES } from "@/components/common/timezones";
import { DAY_LABELS, knownTimezones } from "@/components/integrations/calendarTypes";
import type { CallingHours } from "./callingHours";

type Props = {
  /** Unique id prefix so several forms can share a page. */
  idPrefix: string;
  value: CallingHours;
  onChange: (next: CallingHours) => void;
  disabled?: boolean;
  /** Label of the switch, e.g. "Only call during set hours". */
  switchLabel: string;
  /** Plain-language line under the switch (what happens with it on and off). */
  description: React.ReactNode;
  startLabel: string;
  endLabel: string;
  /** Shown instead of the fields, with the switch locked off, when the feature cannot be used. */
  unavailableReason?: string | null;
};

/** Switch plus (while on) the timezone / days / start-end pickers. */
export function CallingHoursFields({
  idPrefix, value, onChange, disabled, switchLabel, description, startLabel, endLabel, unavailableReason,
}: Props) {
  const zones = useMemo(() => Array.from(new Set(["UTC", value.timezone, ...knownTimezones()])).filter(Boolean), [value.timezone]);
  const set = <K extends keyof CallingHours>(key: K, v: CallingHours[K]) => onChange({ ...value, [key]: v });
  const toggleDay = (d: number) =>
    set("days", value.days.includes(d) ? value.days.filter((x) => x !== d) : [...value.days, d].sort((a, b) => a - b));
  // A feature the server cannot run can still be switched off, never on.
  const locked = !!disabled || (!!unavailableReason && !value.enabled);
  // The browser's time zone is only OFFERED (never pre-selected): it is often not the zone the
  // business runs in, and a wrong zone means calls at the wrong hours. Shown only while none is chosen.
  const detected = useMemo(() => {
    let tz: string | undefined;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { tz = undefined; }   // no guess when it cannot be read
    return tz && (tz === "UTC" || knownTimezones().includes(tz)) ? tz : null;
  }, []);
  const detectedLabel = detected ? COMMON_TIMEZONES.find((z) => z.value === detected)?.label ?? detected : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 rounded-md border border-input p-3">
        <div>
          <Label htmlFor={`${idPrefix}-on`} className="text-sm font-medium">{switchLabel}</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          {unavailableReason && !value.enabled && <p className="mt-1 text-xs text-warning">{unavailableReason}</p>}
        </div>
        <Switch id={`${idPrefix}-on`} aria-label={switchLabel} checked={value.enabled} disabled={locked}
          onCheckedChange={(v) => set("enabled", v)} />
      </div>

      {value.enabled && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-tz`}>Time Zone <span className="text-destructive">*</span></Label>
            <TimezoneSelect id={`${idPrefix}-tz`} value={value.timezone} zones={zones} disabled={!!disabled}
              placeholder="Select time zone" onChange={(tz) => set("timezone", tz)} />
            {!value.timezone && detected && !disabled && (
              <button type="button" onClick={() => set("timezone", detected)}
                className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                Use my time zone ({detectedLabel})
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Days <span className="text-destructive">*</span></Label>
            <div className="flex flex-wrap gap-2">
              {DAY_LABELS.map((label, d) => {
                const on = value.days.includes(d);
                return (
                  <button key={label} type="button" aria-pressed={on} disabled={!!disabled} onClick={() => toggleDay(d)}
                    className={`rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-60 ${on ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-start`}>{startLabel}</Label>
              <TimeSelect id={`${idPrefix}-start`} value={value.start} disabled={!!disabled} onChange={(v) => set("start", v)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-end`}>{endLabel}</Label>
              <TimeSelect id={`${idPrefix}-end`} value={value.end} disabled={!!disabled} onChange={(v) => set("end", v)} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
