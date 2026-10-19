/**
 * Calling hours: the days and time-of-day window during which an outbound campaign places calls or
 * a phone number's AI receptionist answers (backend: services/call_hours.py). Both store the same
 * five values under their own column prefix: `call_hours_*` on campaigns, `answer_hours_*` on phone
 * numbers. The pickers (days, TimeSelect, TimezoneSelect) are the ones the Callbacks settings use.
 *
 * Campaigns (only) can also run a window of their own per day and have breaks inside a window: one
 * extra column, `call_hours_schedule` (see CallingHours.mode / breaks / schedule). During a break
 * nothing new starts; the campaign carries on by itself when the break ends.
 */
import { knownTimezones } from "@/components/integrations/calendarTypes";
import { formatDue } from "@/components/callbacks/callbackTypes";

/** A stretch inside a day's window during which no new calls start. */
export type Break = { start: string; end: string };

/** One weekday of a custom schedule: on/off and its own window and breaks. */
export type DaySchedule = { on: boolean; start: string; end: string; breaks: Break[] };

/** "same": one window (days, start, end, breaks) every day. "per_day": a DaySchedule for each weekday. */
export type ScheduleMode = "same" | "per_day";

export type CallingHours = {
  enabled: boolean;
  timezone: string;
  days: number[];          // 0 = Monday ... 6 = Sunday
  start: string;           // "HH:MM", 24-hour
  end: string;
  /** Campaigns only; absent (= "same", no breaks) for phone numbers. */
  mode?: ScheduleMode;
  breaks?: Break[];        // the breaks of the same-every-day schedule
  schedule?: DaySchedule[]; // seven entries, index 0 = Monday; used while mode is "per_day"
  /** Whether the per-day schedule was edited / loaded as such (until then it is built from the shared one). */
  scheduleEdited?: boolean;
};

/** What the server says about a row's hours right now (the `*_hours_state` field of a list row). */
export type HoursState = {
  enabled: boolean;
  open: boolean;
  next_open_at: string | null;   // ISO UTC; only while closed
  summary: string | null;        // hours in words; only while enabled
};

/** Column prefix of campaigns and of phone numbers. */
export const CAMPAIGN_PREFIX = "call_hours_";
export const NUMBER_PREFIX = "answer_hours_";

export const DAY_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const MAX_BREAKS = 10;

export const modeOf = (h: CallingHours): ScheduleMode => h.mode ?? "same";
export const breaksOf = (h: CallingHours): Break[] => h.breaks ?? [];

/** The per-day schedule that matches the shared one: the shared days on, each with the shared window and breaks. */
export function scheduleFromShared(h: Pick<CallingHours, "days" | "start" | "end" | "breaks">): DaySchedule[] {
  return Array.from({ length: 7 }, (_, d) => ({
    on: h.days.includes(d), start: h.start, end: h.end, breaks: (h.breaks ?? []).map((b) => ({ ...b })),
  }));
}

/** The seven per-day entries of `h` (built from the shared schedule until a custom one exists). */
export const scheduleOf = (h: CallingHours): DaySchedule[] => h.schedule ?? scheduleFromShared(h);

/**
 * Mon-Fri, 9 to 5, switched off, no breaks, the same every day, and NO timezone: the user has to
 * choose one (an empty timezone is shown as the "Select time zone" placeholder and refused by
 * validateHours once hours are on).
 */
export function defaultHours(): CallingHours {
  const base = { days: [0, 1, 2, 3, 4], start: "09:00", end: "17:00", breaks: [] as Break[] };
  return {
    enabled: false,
    timezone: "",
    ...base,
    mode: "same",
    schedule: scheduleFromShared(base),
    scheduleEdited: false,
  };
}

const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Breaks from stored JSON; anything that is not a start/end pair is dropped. */
function breaksFrom(raw: unknown): Break[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b): b is Break => !!b && typeof b === "object" && typeof (b as Break).start === "string" && typeof (b as Break).end === "string")
    .map((b) => ({ start: b.start, end: b.end }));
}

/**
 * The hours stored on a campaign / phone-number row; anything missing falls back to the defaults.
 * Rows whose hours are off and still hold the server's untouched "UTC" are shown with no timezone
 * (nobody chose it), so enabling them asks for one; a timezone someone saved stays.
 */
export function hoursFromRow(row: Record<string, unknown> | null | undefined, prefix: string): CallingHours {
  const d = defaultHours();
  const r = row ?? {};
  const days = r[`${prefix}days`];
  const shared = {
    days: Array.isArray(days) && days.length ? (days as number[]) : d.days,
    start: typeof r[`${prefix}start`] === "string" ? (r[`${prefix}start`] as string) : d.start,
    end: typeof r[`${prefix}end`] === "string" ? (r[`${prefix}end`] as string) : d.end,
  };
  const out: CallingHours = {
    enabled: r[`${prefix}enabled`] === true,
    timezone: typeof r[`${prefix}timezone`] === "string" && r[`${prefix}timezone`] && !(r[`${prefix}enabled`] !== true && r[`${prefix}timezone`] === "UTC")
      ? (r[`${prefix}timezone`] as string)
      : d.timezone,
    ...shared,
  };
  if (prefix !== CAMPAIGN_PREFIX) return out;

  const raw = r[`${prefix}schedule`];
  const sched = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  out.breaks = breaksFrom(sched.breaks);
  const perDay = sched.mode === "per_day" && sched.days && typeof sched.days === "object";
  out.mode = perDay ? "per_day" : "same";
  if (perDay) {
    const stored = sched.days as Record<string, Partial<DaySchedule> | undefined>;
    out.schedule = Array.from({ length: 7 }, (_, i) => {
      const day = stored[String(i)];
      return day?.on === true
        ? { on: true, start: isTime(day.start) ? day.start : shared.start, end: isTime(day.end) ? day.end : shared.end, breaks: breaksFrom(day.breaks) }
        : { on: false, start: shared.start, end: shared.end, breaks: [] };
    });
    out.scheduleEdited = true;
  } else {
    out.schedule = scheduleFromShared({ ...shared, breaks: out.breaks });
    out.scheduleEdited = false;
  }
  return out;
}

/**
 * The fields to send to the API for `hours`. The timezone is left out while none is chosen (only
 * possible with the hours off), so the server keeps whatever it has stored. Campaigns also send their
 * schedule (only the active mode's data; the server keeps `days`/`start`/`end` as a summary of a per-day one).
 */
export function hoursToPayload(hours: CallingHours, prefix: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    [`${prefix}enabled`]: hours.enabled,
    ...(hours.timezone ? { [`${prefix}timezone`]: hours.timezone } : {}),
    [`${prefix}days`]: [...hours.days].sort((a, b) => a - b),
    [`${prefix}start`]: hours.start,
    [`${prefix}end`]: hours.end,
  };
  if (prefix === CAMPAIGN_PREFIX) {
    if (modeOf(hours) === "per_day") {
      const days: Record<string, unknown> = {};
      scheduleOf(hours).forEach((day, d) => {
        days[String(d)] = day.on
          ? { on: true, start: day.start, end: day.end, breaks: day.breaks.map((b) => ({ start: b.start, end: b.end })) }
          : { on: false };
      });
      payload[`${prefix}schedule`] = { mode: "per_day", days };
    } else {
      payload[`${prefix}schedule`] = { mode: "same", breaks: breaksOf(hours).map((b) => ({ start: b.start, end: b.end })) };
    }
  }
  return payload;
}

/** Whether two sets of hours are the same (day order does not matter). */
export function sameHours(a: CallingHours, b: CallingHours): boolean {
  const days = (h: CallingHours) => [...h.days].sort((x, y) => x - y).join();
  return a.enabled === b.enabled && a.timezone === b.timezone && days(a) === days(b) && a.start === b.start && a.end === b.end
    && modeOf(a) === modeOf(b) && JSON.stringify(breaksOf(a)) === JSON.stringify(breaksOf(b))
    && (modeOf(a) === "same" || JSON.stringify(scheduleOf(a)) === JSON.stringify(scheduleOf(b)));
}

/** Minutes since midnight; an end of 00:00 (12:00 AM) means the end of the day. */
const minutes = (hhmm: string, closing = false): number => {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return closing && m === 0 ? 24 * 60 : m;
};

/** What one window with its breaks gets wrong, keyed like `hoursErrors` (with `key` as the prefix). */
function windowErrors(
  start: string, end: string, breaks: Break[], key: string, errors: Record<string, string>,
) {
  if (![start, end].every(isTime)) { errors[`${key}time`] = "Enter the start and end times."; return; }
  const w0 = minutes(start), w1 = minutes(end, true);
  if (w0 >= w1) { errors[`${key}time`] = "End time must be after start time."; return; }
  if (breaks.length > MAX_BREAKS) errors[`${key}breaks`] = `Add at most ${MAX_BREAKS} breaks.`;
  const ok: { i: number; a: number; b: number }[] = [];
  breaks.forEach((br, i) => {
    if (![br.start, br.end].every(isTime)) { errors[`${key}break:${i}`] = "Enter the break's start and end times."; return; }
    const a = minutes(br.start), b = minutes(br.end, true);
    if (a >= b) errors[`${key}break:${i}`] = "A break must end after it starts.";
    else if (a < w0 || b > w1) errors[`${key}break:${i}`] = `A break must fall inside the running hours (${span(start, end)}).`;
    else ok.push({ i, a, b });
  });
  // Overlap: of two breaks that overlap, the later one is told.
  ok.sort((x, y) => x.a - y.a || x.i - y.i);
  ok.forEach((cur, n) => {
    const prev = ok[n - 1];
    if (prev && cur.a < prev.b && !errors[`${key}break:${cur.i}`]) errors[`${key}break:${cur.i}`] = "Breaks can't overlap.";
  });
  if (!Object.keys(errors).some((k) => k.startsWith(`${key}break:`)) && ok.length && ok.reduce((sum, x) => sum + (x.b - x.a), 0) >= w1 - w0) {
    errors[`${key}breaks`] = "The breaks leave no time to run.";
  }
}

/**
 * Every problem with `h`, keyed by the field it belongs to so the form can show it next to it:
 * "timezone", "days", "time" (the shared start/end), "break:<i>" / "breaks" (shared breaks), and for a
 * custom schedule "day:<d>:time", "day:<d>:break:<i>", "day:<d>:breaks" or "schedule" (no day on).
 * Mirrors the server's checks. The timezone is only required once the hours are switched on; days,
 * times and breaks are always checked, because the server validates them even while the hours are off.
 */
export function hoursErrors(h: CallingHours, zones: string[] = knownTimezones()): Record<string, string> {
  const errors: Record<string, string> = {};
  if (h.enabled && (!h.timezone.trim() || (zones.length > 0 && !["UTC", ...zones].includes(h.timezone)))) errors.timezone = "Select a time zone.";
  if (modeOf(h) === "per_day") {
    const days = scheduleOf(h);
    if (!days.some((d) => d.on)) errors.schedule = "Pick at least one day.";
    days.forEach((day, d) => { if (day.on) windowErrors(day.start, day.end, day.breaks, `day:${d}:`, errors); });
    return errors;
  }
  if (h.days.length === 0) errors.days = "Pick at least one day.";
  windowErrors(h.start, h.end, breaksOf(h), "", errors);
  return errors;
}

/**
 * The first problem with `h` as one sentence (for a toast or a blocked "Next"), or null. A problem in
 * a custom schedule names its day.
 */
export function validateHours(h: CallingHours, zones: string[] = knownTimezones()): string | null {
  const errors = hoursErrors(h, zones);
  const first = Object.keys(errors)[0];
  if (!first) return null;
  const day = /^day:(\d):/.exec(first);
  return day ? `${DAY_FULL[Number(day[1])]}: ${errors[first]}` : errors[first];
}

/** "Mon–Fri", "Every day", "Mon–Wed, Sat" ... for a set of days. */
export function daysText(days: number[], labels: string[]): string {
  const sorted = Array.from(new Set(days)).sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  const runs: number[][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1] + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) => (r.length === 1 ? labels[r[0]] : r.length === 2 ? `${labels[r[0]]}, ${labels[r[1]]}` : `${labels[r[0]]}–${labels[r[r.length - 1]]}`))
    .join(", ");
}

const clock = (hhmm: string): string => {
  const h = Number(hhmm.slice(0, 2));
  const m = hhmm.slice(3, 5);
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
};

/** The times of day in words: "9:00 AM–5:00 PM", "8:00 AM–midnight" (an end of 00:00 is the end of the day) or "all day". */
const span = (start: string, end: string): string =>
  start === "00:00" && end === "00:00" ? "all day" : `${clock(start)}–${end === "00:00" ? "midnight" : clock(end)}`;

const breaksText = (breaks: Break[]): string => breaks.map((b) => span(b.start, b.end)).join(" and ");

/**
 * "Mon–Fri, 9:00 AM–5:00 PM (America/New_York)"; with breaks "..., break 1:00 PM–2:00 PM"; a custom
 * schedule groups the days that share hours: "Mon–Fri 9:00 AM–6:00 PM (break ...); Sat 10:00 AM–2:00 PM (zone)".
 */
export function describeHours(h: CallingHours, labels: string[]): string {
  if (modeOf(h) === "per_day") {
    const groups = new Map<string, { day: DaySchedule; days: number[] }>();
    scheduleOf(h).forEach((day, d) => {
      if (!day.on) return;
      const key = JSON.stringify([day.start, day.end, day.breaks]);
      const g = groups.get(key);
      if (g) g.days.push(d); else groups.set(key, { day, days: [d] });
    });
    const parts = [...groups.values()].map(({ day, days }) =>
      `${daysText(days, labels)} ${span(day.start, day.end)}${day.breaks.length ? ` (break ${breaksText(day.breaks)})` : ""}`);
    return `${parts.join("; ")} (${h.timezone})`;
  }
  const breaks = breaksOf(h);
  return `${daysText(h.days, labels)}, ${span(h.start, h.end)}${breaks.length ? `, break ${breaksText(breaks)}` : ""} (${h.timezone})`;
}

/** A new break that fits inside `start`..`end` and clear of `existing`: lunchtime first, then other common gaps. */
export function newBreak(start: string, end: string, existing: Break[]): Break {
  const ok = isTime(start) && isTime(end);
  const w0 = ok ? minutes(start) : 0, w1 = ok ? minutes(end, true) : 24 * 60;
  const t = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const taken = existing.filter((b) => isTime(b.start) && isTime(b.end)).map((b) => [minutes(b.start), minutes(b.end, true)]);
  const free = (a: number, b: number) => a >= w0 && b <= w1 && a < b && taken.every(([x, y]) => b <= x || a >= y);
  const candidates: [number, number][] = [[13 * 60, 14 * 60], [12 * 60, 12 * 60 + 30], [15 * 60, 15 * 60 + 30], [10 * 60 + 30, 10 * 60 + 45], [17 * 60, 17 * 60 + 15]];
  // Anything else: the first 15 minutes of the window that are free.
  for (let m = w0; m + 15 <= w1; m += 15) candidates.push([m, m + 15]);
  const pick = candidates.find(([a, b]) => free(a, b)) ?? candidates[0];
  return { start: t(pick[0]), end: pick[1] === 24 * 60 ? "00:00" : t(pick[1]) };
}

/**
 * "Tue, Oct 14, 9:00 AM GMT-4": when a closed campaign or number opens next, in the zone the user
 * chose for it (never a made-up one: without a zone the viewer's own is used, and named).
 */
export function describeNextOpen(state: HoursState | undefined, timezone?: string | null): string | null {
  return state?.next_open_at ? formatDue(state.next_open_at, timezone || "") : null;
}
