/**
 * Helpers for the referral partner commission reports (components/partners/CommissionReport.tsx): the request the
 * period selector turns into, how a period is named, and the checks done before asking the server (which repeats them).
 * The numbers themselves are computed in backend/services/partner_reports.py; dates here are plain "YYYY-MM-DD" strings
 * (calendar days in the browser's time zone, which is also what is sent as `tz`).
 */
import { todayISO } from "@/lib/partners";

export type ReportGroup = "day" | "week" | "month" | "year";
/** What the user picks: a ready-made grouping over its default range, or their own dates. */
export type ReportPreset = "week" | "month" | "year" | "custom";

export const PRESETS: { value: ReportPreset; label: string; hint: string }[] = [
  { value: "week", label: "Weekly", hint: "last 12 weeks" },
  { value: "month", label: "Monthly", hint: "last 12 months" },
  { value: "year", label: "Annual", hint: "last 5 years" },
  { value: "custom", label: "Custom range", hint: "pick the dates" },
];
export const CUSTOM_GROUPS: { value: ReportGroup; label: string }[] = [
  { value: "day", label: "Day" }, { value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "year", label: "Year" },
];
export const EARLIEST_REPORT_DATE = "2020-01-01";

export type ReportQuery = { group: ReportGroup; start?: string; end?: string; tz: string; partner_id?: string };

type Counts = { signups: number; verified: number; calls: number };
/** Every figure a partner sees. The three platform figures are admin-only and absent from a partner's report. */
export type ReportNumbers = Counts & { billed: number; commission: number; platform_cost?: number; profit?: number; net_profit?: number };
export type ReportRow = ReportNumbers & { key: string; start: string; end: string };
export type ReportPartner = { id: string; name: string; status: string; commission_label: string; total: Required<ReportNumbers> };
export type CommissionReportData = {
  group: ReportGroup; tz: string; start: string; end: string; periods: ReportRow[]; total: ReportNumbers;
  commission_label?: string; partners?: ReportPartner[];
};

/** The browser's IANA time zone ("Asia/Karachi"), "UTC" when it cannot tell. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The server request for the current selection, or null while a custom range is incomplete or invalid. */
export function buildReportQuery(
  preset: ReportPreset, custom: { group: ReportGroup; start: string; end: string }, partnerId: string, tz: string, today: string = todayISO(),
): ReportQuery | null {
  const partner = partnerId && partnerId !== "all" ? { partner_id: partnerId } : {};
  if (preset !== "custom") return { group: preset, tz, ...partner };
  if (!customRangeReady(custom.start, custom.end, today)) return null;
  return { group: custom.group, start: custom.start, end: custom.end, tz, ...partner };
}

/** Why a custom range cannot be used (null when it can). Empty fields give no message: the user has not finished. */
export function customRangeError(start: string, end: string, today: string = todayISO()): string | null {
  if (!start || !end) return null;
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (!valid(start) || !valid(end)) return "Enter both dates.";
  if (start < EARLIEST_REPORT_DATE) return "Reports start on 1 Jan 2020.";
  if (start > today) return "The start date cannot be in the future.";
  if (start > end) return "The start date must be on or before the end date.";
  return null;
}

/** True once a custom range has two valid dates (so the table can load). */
export function customRangeReady(start: string, end: string, today: string = todayISO()): boolean {
  return !!start && !!end && customRangeError(start, end, today) === null;
}

function parseDay(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** A date such as "Nov 2, 2026" (the calendar day as written, whatever the viewer's time zone). */
export function reportDay(iso: string, locale?: string): string {
  const d = parseDay(iso);
  return d ? d.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }) : "";
}

/** The name of a period from its first day: "Nov 6, 2026" / "Week of Nov 2, 2026" / "Nov 2026" / "2026". */
export function periodLabel(group: ReportGroup, key: string, locale?: string): string {
  const d = parseDay(key);
  if (!d) return "";
  if (group === "day") return d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  if (group === "week") return `Week of ${reportDay(key, locale)}`;
  if (group === "month") return d.toLocaleDateString(locale, { month: "long", year: "numeric" });
  return String(d.getFullYear());
}

/** The dates a period really covers ("Nov 4 – Nov 8, 2026") when they differ from its natural span: always for a week,
 *  and for a month, year or day only where the range cut it short. "" when the name already says it all. */
export function periodSpan(group: ReportGroup, row: Pick<ReportRow, "key" | "start" | "end">, locale?: string): string {
  const range = `${reportDay(row.start, locale)} – ${reportDay(row.end, locale)}`;
  if (group === "week") return range;
  if (group === "day") return "";
  const k = parseDay(row.key), s = parseDay(row.start), e = parseDay(row.end);
  if (!k || !s || !e) return "";
  const last = group === "month" ? new Date(k.getFullYear(), k.getMonth() + 1, 0) : new Date(k.getFullYear(), 11, 31);
  return s.getTime() === k.getTime() && e.getTime() === last.getTime() ? "" : range;
}

/** File name for the CSV of the report on screen; `scope` (a partner's name, or "all-partners") is left out for a partner's own. */
export function reportFilename(report: Pick<CommissionReportData, "group" | "start" | "end">, scope?: string): string {
  const safe = scope === undefined ? "" : (scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "partner");
  return `commission-report-${safe ? `${safe}-` : ""}${report.group}-${report.start}_to_${report.end}.csv`;
}
