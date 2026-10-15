/**
 * Showing a moment in a time zone the USER chose (a campaign's calling hours, a receptionist number's
 * answering hours), rather than wherever the browser happens to be. The server decides which zone a
 * logged call belongs to (`display_timezone` on a conversation); these helpers only format.
 *
 * Every result carries the zone's short name ("PDT", "GMT+5"), so a row is never ambiguous, including
 * rows that have no chosen zone and are shown in the viewer's own zone.
 */

/** True when `tz` is a time zone this browser can format with. */
export function isValidZone(tz: string | null | undefined): tz is string {
  if (!tz || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The zone to format with: the chosen one when usable, otherwise undefined (the viewer's own). */
const zoneOrViewer = (tz: string | null | undefined): string | undefined => (isValidZone(tz) ? tz : undefined);

/** "Oct 14, 2026, 9:00 AM GMT+5": date and time in `tz` (or the viewer's zone when none), with the zone name. */
export function formatInZone(value: string | number | Date | null | undefined, tz?: string | null): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: zoneOrViewer(tz), timeZoneName: "short",
  }).format(d);
}

/** "9:00:05 AM GMT+5": the time of day only (for the events inside one call), with the zone name. */
export function formatTimeInZone(value: string | number | Date | null | undefined, tz?: string | null): string {
  if (value === null || value === undefined || value === "") return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : "—";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: zoneOrViewer(tz), timeZoneName: "short",
  }).format(d);
}
