export type CalendarSettings = {
  timezone: string;
  work_days: number[];          // 0 = Monday ... 6 = Sunday
  start_time: string;           // "09:00"
  end_time: string;             // "17:00"
  slot_minutes: number;
  buffer_minutes: number;
  min_notice_hours: number;
  max_days_ahead: number;
};

export type CalendarStatus = {
  configured: boolean;          // the server has Google credentials
  redirect_uri: string;         // what to register as the Authorized redirect URI in Google Cloud
  connected: boolean;
  status: "connected" | "reauth_required" | null;
  email: string | null;
  settings: CalendarSettings;
};

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const knownTimezones = (): string[] => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (list?.length) return list;
  } catch { /* fall through */ }
  return ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Asia/Karachi", "Asia/Dubai", "Asia/Kolkata"];
};

export const hoursSummary = (s: CalendarSettings): string => {
  const days = s.work_days.length === 7 ? "Every day"
    : s.work_days.join() === "0,1,2,3,4" ? "Mon–Fri"
    : s.work_days.map((d) => DAY_LABELS[d]).join(", ");
  return `${days}, ${s.start_time}–${s.end_time} (${s.timezone})`;
};

/** Bounds mirror the server's validation, so the form can explain problems before saving. */
export const CALENDAR_LIMITS = {
  slot_minutes: [10, 240],
  buffer_minutes: [0, 120],
  min_notice_hours: [0, 168],
  max_days_ahead: [1, 90],
} as const;

export const validateCalendarSettings = (s: CalendarSettings, zones: string[] = knownTimezones()): string | null => {
  if (!s.timezone.trim() || (zones.length > 0 && !zones.includes(s.timezone))) return "Choose a timezone from the list.";
  if (s.work_days.length === 0) return "Pick at least one working day.";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.start_time) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.end_time)) return "Enter the start and end time.";
  if (s.start_time >= s.end_time) return "End time must be after start time.";
  const labels: Record<keyof typeof CALENDAR_LIMITS, string> = {
    slot_minutes: "Meeting length", buffer_minutes: "Buffer", min_notice_hours: "Minimum notice", max_days_ahead: "Booking window",
  };
  for (const key of Object.keys(CALENDAR_LIMITS) as (keyof typeof CALENDAR_LIMITS)[]) {
    const [lo, hi] = CALENDAR_LIMITS[key];
    const v = s[key];
    if (!Number.isInteger(v) || v < lo || v > hi) return `${labels[key]} must be a whole number from ${lo} to ${hi}.`;
  }
  return null;
};
