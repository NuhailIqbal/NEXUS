import { knownTimezones } from "@/components/integrations/calendarTypes";

export type CallbackStatus = "pending" | "calling" | "called" | "failed" | "cancelled" | "skipped";

export type Callback = {
  id: string;
  agent_id: string | null;
  agent_name: string;
  contact_name: string | null;
  phone: string | null;
  due_at: string;                       // ISO, UTC
  timezone: string;
  time_source: "caller" | "default" | "manual";
  requested_text: string | null;
  status: CallbackStatus;
  attempts: number;
  last_error: string | null;
  placed_call_id: string | null;
  created_at: string;
};

export type CallbackSettings = {
  auto_call: boolean;
  timezone: string;
  work_days: number[];                  // 0 = Monday ... 6 = Sunday
  start_time: string;
  end_time: string;
  default_time: string;
  retry_minutes: number;
  max_attempts: number;
};

export type CallbackCounts = Record<CallbackStatus, number>;

export const STATUS_LABEL: Record<CallbackStatus, string> = {
  pending: "Scheduled",
  calling: "Calling now",
  called: "Called",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

export const SOURCE_LABEL: Record<Callback["time_source"], string> = {
  caller: "Time the caller asked for",
  default: "Default time (caller gave none)",
  manual: "Set by a person",
};

const safeZone = (tz: string): string | undefined => {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz; } catch { return undefined; }
};

/** "Tue, Oct 6, 5:00 PM GMT+5" — the moment in the callback's own timezone. */
export function formatDue(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: safeZone(tz), timeZoneName: "short",
  }).format(d);
}

/** Value for <input type="datetime-local"> showing the moment in the given timezone. */
export function toLocalInput(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      timeZone: safeZone(tz),
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Scheduled in the past but still waiting (nobody has called, and it isn't being placed). */
export const isOverdue = (cb: Callback, now: Date = new Date()): boolean =>
  cb.status === "pending" && new Date(cb.due_at).getTime() < now.getTime();

export const CALLBACK_LIMITS = { retry_minutes: [5, 1440], max_attempts: [1, 5] } as const;

/** Mirrors the server's checks so the form can explain a problem before saving. */
export function validateCallbackSettings(s: CallbackSettings, zones: string[] = knownTimezones()): string | null {
  const t = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!s.timezone.trim() || (zones.length > 0 && !["UTC", ...zones].includes(s.timezone))) return "Choose a timezone from the list.";
  if (s.work_days.length === 0) return "Pick at least one calling day.";
  if (![s.start_time, s.end_time, s.default_time].every((x) => t.test(x))) return "Enter the start, end and default times.";
  if (s.start_time >= s.end_time) return "End time must be after start time.";
  if (s.default_time < s.start_time || s.default_time >= s.end_time) return "The default callback time must fall inside your calling hours.";
  if (!Number.isInteger(s.retry_minutes) || s.retry_minutes < 5 || s.retry_minutes > 1440) return "Retry delay must be a whole number from 5 to 1440.";
  if (!Number.isInteger(s.max_attempts) || s.max_attempts < 1 || s.max_attempts > 5) return "Attempts must be a whole number from 1 to 5.";
  return null;
}
