/**
 * Helpers for the admin "Financial summary" of the referral partners (components/partners/FinancialSummary.tsx): the
 * response types, the chart's series and colours, and how its points and file name are made. The numbers are computed in
 * backend/services/partner_financials.py; the period selector and its request are shared with the commission report
 * (lib/partnerReports.ts).
 */
import { periodLabel, type ReportGroup } from "@/lib/partnerReports";

/** Money of one period, one partner or the whole range. `owed_start` / `owed` are what was owed at the start / end of it
 *  (negative = overpaid); owed_start + commission - paid = owed on every row. */
export type FinanceNumbers = {
  billed: number; platform_cost: number; profit: number; commission: number; paid: number; owed_start: number; owed: number; net_kept: number;
};
export type FinanceRow = FinanceNumbers & { key: string; start: string; end: string };
export type FinancePartner = { id: string; name: string; status: string; commission_label: string; total: FinanceNumbers };
export type FinancialSummaryData = {
  group: ReportGroup; tz: string; start: string; end: string; periods: FinanceRow[]; total: FinanceNumbers; partners: FinancePartner[];
};

export type FinanceSeriesKey = "net_kept" | "commission" | "paid";
/** The three things the trend compares, in the fixed order their colours are assigned. */
export const FINANCE_SERIES: { key: FinanceSeriesKey; label: string }[] = [
  { key: "net_kept", label: "Net kept by platform" },
  { key: "commission", label: "Commission earned" },
  { key: "paid", label: "Commission paid" },
];
/** Categorical slots 1-3 of the data-viz palette (blue, orange, aqua), stepped for each surface. */
export const FINANCE_COLORS = {
  light: { net_kept: "#2a78d6", commission: "#eb6834", paid: "#1baf7a" },
  dark: { net_kept: "#3987e5", commission: "#d95926", paid: "#199e70" },
} as const;

export type FinancePoint = { key: string; label: string; tip: string } & Record<FinanceSeriesKey, number>;

function shortLabel(group: ReportGroup, key: string, locale?: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  if (group === "year") return String(d.getFullYear());
  if (group === "month") return d.toLocaleDateString(locale, { month: "short", year: "2-digit" });
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The chart's points, oldest first: a short axis label and the full period name for the tooltip. */
export function financePoints(periods: FinanceRow[], group: ReportGroup, locale?: string): FinancePoint[] {
  return periods.map((p) => ({
    key: p.key, label: shortLabel(group, p.key, locale), tip: periodLabel(group, p.key, locale),
    net_kept: p.net_kept, commission: p.commission, paid: p.paid,
  }));
}

/** What a balance means in words: still owed, settled, or overpaid (the rate was lowered after paying). */
export function owedWording(owed: number): { label: string; tone: "owed" | "settled" | "overpaid" } {
  const cents = Math.round(owed * 100);
  if (cents > 0) return { label: "Commission still owed", tone: "owed" };
  if (cents < 0) return { label: "Overpaid to partners", tone: "overpaid" };
  return { label: "Commission still owed", tone: "settled" };
}

/** File name for the CSV of the summary on screen. */
export function financeFilename(r: Pick<FinancialSummaryData, "group" | "start" | "end">): string {
  return `financial-summary-${r.group}-${r.start}_to_${r.end}.csv`;
}
