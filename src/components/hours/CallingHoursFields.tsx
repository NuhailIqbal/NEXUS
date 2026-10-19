/**
 * The calling-hours form shared by outbound campaigns and AI receptionists: an on/off switch and,
 * while it is on, timezone, days and start/end times. The pickers and their layout are the ones in
 * the Callbacks settings (TimezoneSelect, day buttons, TimeSelect), so all three read the same.
 *
 * With `advanced` (campaigns) the form also offers a choice between the same hours every day and
 * hours of their own per day (each day on or off, with its own start and end and a "Copy to all days"
 * shortcut), and breaks inside the running hours; problems are shown next to the field they belong to.
 * Controlled: the parent owns the CallingHours value and saves it. No API calls.
 */
import { useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { TimeSelect } from "@/components/common/TimeSelect";
import { TimezoneSelect } from "@/components/common/TimezoneSelect";
import { COMMON_TIMEZONES } from "@/components/common/timezones";
import { DAY_LABELS, knownTimezones } from "@/components/integrations/calendarTypes";
import {
  DAY_FULL, MAX_BREAKS, breaksOf, hoursErrors, modeOf, newBreak, scheduleFromShared, scheduleOf,
  type Break, type CallingHours, type DaySchedule, type ScheduleMode,
} from "./callingHours";

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
  /** Offer a custom schedule per day and breaks (campaigns). */
  advanced?: boolean;
};

const Problem = ({ text }: { text?: string }) =>
  text ? <p role="alert" className="text-xs text-destructive">{text}</p> : null;

/** The breaks of one window: a row per break (start, end, remove) and an "Add break" button. */
function BreakList({
  idBase, who, windowStart, windowEnd, breaks, onChange, errors, errorKey, disabled,
}: {
  idBase: string;
  /** "" for the shared schedule, "Monday" for a day of a custom one (used in the accessible names). */
  who: string;
  windowStart: string;
  windowEnd: string;
  breaks: Break[];
  onChange: (next: Break[]) => void;
  errors: Record<string, string>;
  /** Key prefix of this window's errors in `errors` ("" or "day:1:"). */
  errorKey: string;
  disabled?: boolean;
}) {
  const name = (i: number, which: string) => `${who ? `${who} break` : "Break"} ${i + 1} ${which}`;
  const edit = (i: number, patch: Partial<Break>) => onChange(breaks.map((b, n) => (n === i ? { ...b, ...patch } : b)));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">Breaks</span>
        <Button type="button" variant="outline" size="sm" disabled={!!disabled || breaks.length >= MAX_BREAKS}
          aria-label={who ? `Add ${who} break` : "Add break"}
          onClick={() => onChange([...breaks, newBreak(windowStart, windowEnd, breaks)])}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add break
        </Button>
      </div>
      {breaks.length === 0 && (
        <p className="text-xs text-muted-foreground">No breaks. Add one for lunch or any gap when no new calls should start.</p>
      )}
      {breaks.map((b, i) => (
        <div key={i} className="space-y-1">
          <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Break starts</span>
              <TimeSelect id={`${idBase}-b${i}-start`} ariaLabel={name(i, "start")} value={b.start} disabled={!!disabled}
                onChange={(v) => edit(i, { start: v })} />
            </div>
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground">Break ends</span>
              <TimeSelect id={`${idBase}-b${i}-end`} ariaLabel={name(i, "end")} value={b.end} disabled={!!disabled}
                onChange={(v) => edit(i, { end: v })} />
            </div>
            <Button type="button" variant="ghost" size="icon" disabled={!!disabled}
              aria-label={`Remove ${who ? `${who} break` : "break"} ${i + 1}`}
              onClick={() => onChange(breaks.filter((_, n) => n !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          <Problem text={errors[`${errorKey}break:${i}`]} />
        </div>
      ))}
      <Problem text={errors[`${errorKey}breaks`]} />
    </div>
  );
}

/** Switch plus (while on) the timezone / days / start-end pickers (and, with `advanced`, per-day hours and breaks). */
export function CallingHoursFields({
  idPrefix, value, onChange, disabled, switchLabel, description, startLabel, endLabel, unavailableReason, advanced,
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

  const mode: ScheduleMode = advanced ? modeOf(value) : "same";
  const errors = useMemo(() => (advanced && value.enabled ? hoursErrors(value) : {}), [advanced, value]);
  const days = scheduleOf(value);

  /** Switching to a custom schedule starts from the shared one, unless a custom one was already made. */
  const chooseMode = (next: ScheduleMode) => {
    if (next === mode) return;
    if (next === "per_day" && !value.scheduleEdited) {
      onChange({ ...value, mode: next, schedule: scheduleFromShared({ ...value, breaks: breaksOf(value) }) });
    } else {
      onChange({ ...value, mode: next });
    }
  };
  const setDay = (d: number, patch: Partial<DaySchedule>) =>
    onChange({ ...value, mode: "per_day", scheduleEdited: true, schedule: days.map((day, n) => (n === d ? { ...day, ...patch } : day)) });
  /** One day's hours and breaks go to every other day that is switched on (days that are off stay off). */
  const copyToAll = (d: number) => {
    const from = days[d];
    onChange({
      ...value, mode: "per_day", scheduleEdited: true,
      schedule: days.map((day, n) => (n === d || !day.on ? day : { ...day, start: from.start, end: from.end, breaks: from.breaks.map((b) => ({ ...b })) })),
    });
  };

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

          {advanced && (
            <div className="space-y-1.5">
              <Label id={`${idPrefix}-mode-label`}>Schedule</Label>
              <div role="radiogroup" aria-labelledby={`${idPrefix}-mode-label`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {([["same", "Same schedule every day"], ["per_day", "Custom schedule per day"]] as const).map(([m, text]) => (
                  <button key={m} type="button" role="radio" aria-checked={mode === m} disabled={!!disabled} onClick={() => chooseMode(m)}
                    className={`rounded-md border px-3 py-2 text-left text-sm transition disabled:opacity-60 ${mode === m ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:bg-muted"}`}>
                    {text}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {mode === "same"
                  ? "The same days and hours apply every week."
                  : "Switch each day on or off and give it its own hours. Breaks pause the calls and they carry on by themselves when the break ends."}
              </p>
            </div>
          )}

          {mode === "same" && (
            <>
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
                <Problem text={errors.days} />
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
              <Problem text={errors.time} />

              {advanced && (
                <BreakList idBase={`${idPrefix}-shared`} who="" windowStart={value.start} windowEnd={value.end}
                  breaks={breaksOf(value)} onChange={(b) => set("breaks", b)} errors={errors} errorKey="" disabled={disabled} />
              )}
            </>
          )}

          {mode === "per_day" && (
            <div className="space-y-3">
              <Problem text={errors.schedule} />
              {days.map((day, d) => (
                <div key={d} className="space-y-3 rounded-md border border-input p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <Switch id={`${idPrefix}-day${d}-on`} aria-label={DAY_FULL[d]} checked={day.on} disabled={!!disabled}
                        onCheckedChange={(v) => setDay(d, { on: v })} />
                      <span className="text-sm font-medium">{DAY_FULL[d]}</span>
                      {!day.on && <span className="text-xs text-muted-foreground">Off: no calls</span>}
                    </div>
                    {day.on && (
                      <Button type="button" variant="ghost" size="sm" disabled={!!disabled} aria-label={`Copy ${DAY_FULL[d]} to all days`}
                        title="Give every other day that is switched on these hours and breaks" onClick={() => copyToAll(d)}>
                        Copy to all days
                      </Button>
                    )}
                  </div>
                  {day.on && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">{startLabel}</span>
                          <TimeSelect id={`${idPrefix}-day${d}-start`} ariaLabel={`${DAY_FULL[d]} start`} value={day.start}
                            disabled={!!disabled} onChange={(v) => setDay(d, { start: v })} />
                        </div>
                        <div className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">{endLabel}</span>
                          <TimeSelect id={`${idPrefix}-day${d}-end`} ariaLabel={`${DAY_FULL[d]} end`} value={day.end}
                            disabled={!!disabled} onChange={(v) => setDay(d, { end: v })} />
                        </div>
                      </div>
                      <Problem text={errors[`day:${d}:time`]} />
                      <BreakList idBase={`${idPrefix}-day${d}`} who={DAY_FULL[d]} windowStart={day.start} windowEnd={day.end}
                        breaks={day.breaks} onChange={(b) => setDay(d, { breaks: b })} errors={errors} errorKey={`day:${d}:`} disabled={disabled} />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
