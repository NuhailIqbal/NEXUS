/**
 * Calling hours: the days and time-of-day window during which an outbound campaign places calls or
 * a phone number's AI receptionist answers (backend: services/call_hours.py). Both store the same
 * five values under their own column prefix: `call_hours_*` on campaigns, `answer_hours_*` on phone
 * numbers. The pickers (days, TimeSelect, TimezoneSelect) are the ones the Callbacks settings use.
 */
import { knownTimezones } from "@/components/integrations/calendarTypes";
import { formatDue } from "@/components/callbacks/callbackTypes";

export type CallingHours = {
  enabled: boolean;
  timezone: string;
  days: number[];          // 0 = Monday ... 6 = Sunday
  start: string;           // "HH:MM", 24-hour
  end: string;
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

/**
 * Mon-Fri, 9 to 5, switched off, and NO timezone: the user has to choose one (an empty timezone is
 * shown as the "Select time zone" placeholder and refused by validateHours once hours are on).
 */
export function defaultHours(): CallingHours {
  return {
    enabled: false,
    timezone: "",
    days: [0, 1, 2, 3, 4],
    start: "09:00",
    end: "17:00",
  };
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
  return {
    enabled: r[`${prefix}enabled`] === true,
    timezone: typeof r[`${prefix}timezone`] === "string" && r[`${prefix}timezone`] && !(r[`${prefix}enabled`] !== true && r[`${prefix}timezone`] === "UTC")
      ? (r[`${prefix}timezone`] as string)
      : d.timezone,
    days: Array.isArray(days) && days.length ? (days as number[]) : d.days,
    start: typeof r[`${prefix}start`] === "string" ? (r[`${prefix}start`] as string) : d.start,
    end: typeof r[`${prefix}end`] === "string" ? (r[`${prefix}end`] as string) : d.end,
  };
}

/**
 * The fields to send to the API for `hours`. The timezone is left out while none is chosen (only
 * possible with the hours off), so the server keeps whatever it has stored.
 */
export function hoursToPayload(hours: CallingHours, prefix: string): Record<string, unknown> {
  return {
    [`${prefix}enabled`]: hours.enabled,
    ...(hours.timezone ? { [`${prefix}timezone`]: hours.timezone } : {}),
    [`${prefix}days`]: [...hours.days].sort((a, b) => a - b),
    [`${prefix}start`]: hours.start,
    [`${prefix}end`]: hours.end,
  };
}

/** Whether two sets of hours are the same (day order does not matter). */
export function sameHours(a: CallingHours, b: CallingHours): boolean {
  const days = (h: CallingHours) => [...h.days].sort((x, y) => x - y).join();
  return a.enabled === b.enabled && a.timezone === b.timezone && days(a) === days(b) && a.start === b.start && a.end === b.end;
}

/** Minutes since midnight; an end of 00:00 (12:00 AM) means the end of the day. */
const minutes = (hhmm: string, closing = false): number => {
  const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return closing && m === 0 ? 24 * 60 : m;
};

/**
 * Mirrors the server's checks so the form can explain a problem before saving. The timezone is only
 * required once the hours are switched on (switched off, it may still be unchosen); days and times
 * are always checked, because the server validates them even while the hours are off.
 */
export function validateHours(h: CallingHours, zones: string[] = knownTimezones()): string | null {
  const t = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (h.enabled && (!h.timezone.trim() || (zones.length > 0 && !["UTC", ...zones].includes(h.timezone)))) return "Select a time zone.";
  if (h.days.length === 0) return "Pick at least one day.";
  if (![h.start, h.end].every((x) => t.test(x))) return "Enter the start and end times.";
  if (minutes(h.start) >= minutes(h.end, true)) return "End time must be after start time.";
  return null;
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

/** "Mon–Fri, 9:00 AM–5:00 PM (America/New_York)". */
export function describeHours(h: CallingHours, labels: string[]): string {
  return `${daysText(h.days, labels)}, ${span(h.start, h.end)} (${h.timezone})`;
}

/**
 * "Tue, Oct 14, 9:00 AM GMT-4": when a closed campaign or number opens next, in the zone the user
 * chose for it (never a made-up one: without a zone the viewer's own is used, and named).
 */
export function describeNextOpen(state: HoursState | undefined, timezone?: string | null): string | null {
  return state?.next_open_at ? formatDue(state.next_open_at, timezone || "") : null;
}
