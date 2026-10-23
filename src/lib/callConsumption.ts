/**
 * Shared types, constants and small pure helpers for the Call Consumption pages
 * (pages/dashboard/call-consumption/*, components/call-consumption/*). The numbers themselves come from
 * the backend (services/call_consumption.py): this file only formats them and builds the query string.
 *
 * Vocabulary: a finished call is either "consumed" (a person answered and spoke with the AI) or "dropped",
 * and a dropped call has exactly one reason (a DropBucket). consumed + dropped = total, always.
 */

/** Why a call was dropped, in the fixed order every table lists its columns (matches the backend's DROP_BUCKETS). */
export const DROP_BUCKETS = ["no_answer", "busy", "voicemail", "hung_up", "blocked", "failed"] as const;
export type DropBucket = (typeof DROP_BUCKETS)[number];

export const BUCKET_LABELS: Record<DropBucket, string> = {
  no_answer: "No answer",
  busy: "Busy",
  voicemail: "Voicemail",
  hung_up: "Hung up at once",
  blocked: "Blocked",
  failed: "Failed",
};

/** One fixed colour per reason, so a reason looks the same in every chart on every page. */
export const BUCKET_COLORS: Record<DropBucket, string> = {
  no_answer: "#f59e0b",
  busy: "#8b5cf6",
  voicemail: "#06b6d4",
  hung_up: "#ec4899",
  blocked: "#64748b",
  failed: "#ef4444",
};

export const CONSUMED_COLOR = "hsl(var(--success))";
export const DROPPED_COLOR = "hsl(var(--destructive))";

/** Counts shared by every row the report returns (a tree node, a segment, an hour, a Total). */
export type Tally = {
  total_calls: number;
  consumed_calls: number;
  consumption_pct: number;
  dropped_calls: number;
  drop_pct: number;
  buckets: Record<DropBucket, number>;
  dropped_cost: number;
};

export type TreeRow = Tally & {
  name: string; start_date?: string; end_date?: string; key?: string; hour?: number; children?: TreeRow[];
  /** Weekly / monthly rows only: the change against the period before (null when that had no calls), and whether
   * the period is cut by the chosen range or still running. */
  calls_change_pct?: number | null; drop_pct_point_change?: number | null; partial?: boolean;
};
export type SummaryResponse = { has_data: boolean; rows: TreeRow[]; total: TreeRow };

export type Dimension = "campaign" | "vertical" | "state";

// ---------------------------------------------------------------------------------------------- filters

export type CCFilters = {
  from: string; // YYYY-MM-DD, in `tz`
  to: string;
  tz: string;
  campaignIds: string[];
  /** 2-letter state codes (State page only); empty = every state. */
  states: string[];
  /** NEXUS phone number ids (Inbound & Outbound page, inbound tab only); empty = every number. */
  numberIds: string[];
  vertical: string;
  agentId: string;
  direction: string;
  disposition: string;
};

/** The viewer's own IANA zone: days and hours are bucketed in it. Falls back to UTC if the browser has none. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** YYYY-MM-DD of a Date using its LOCAL calendar fields (toISOString would shift the day for zones east/west of UTC). */
export function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export type RangePreset = "today" | "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth";

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
];

/** {from, to} for a preset, relative to `now`. */
export function presetRange(preset: RangePreset, now: Date = new Date()): { from: string; to: string } {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  switch (preset) {
    case "today": return { from: ymd(day(0)), to: ymd(day(0)) };
    case "yesterday": return { from: ymd(day(-1)), to: ymd(day(-1)) };
    case "last7": return { from: ymd(day(-6)), to: ymd(day(0)) };
    case "last30": return { from: ymd(day(-29)), to: ymd(day(0)) };
    case "thisMonth": return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(day(0)) };
    case "lastMonth": return {
      from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
      to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)),
    };
  }
}

/** A named date range with its dates (what a preset select offers). */
export type PeriodPreset = { value: string; label: string; from: string; to: string };

/**
 * Date presets for the Weekly / Monthly report: whole weeks (Sunday to Saturday) or whole calendar months, ending at the
 * last FINISHED one, so no row at the edge is cut. `includeCurrent` extends the end to the end of the current, still
 * running, week / month (that last row is then shown as partial).
 */
export function periodPresets(granularity: "weekly" | "monthly", includeCurrent: boolean, now: Date = new Date()): PeriodPreset[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (granularity === "weekly") {
    const thisStart = new Date(y, m, now.getDate() - now.getDay()); // Sunday of this week
    const lastStart = new Date(thisStart.getFullYear(), thisStart.getMonth(), thisStart.getDate() - (includeCurrent ? 0 : 7));
    const lastEnd = new Date(lastStart.getFullYear(), lastStart.getMonth(), lastStart.getDate() + 6);
    return [4, 8, 12, 26].map((n) => ({
      value: `w${n}`,
      label: `Last ${n} weeks`,
      from: ymd(new Date(lastStart.getFullYear(), lastStart.getMonth(), lastStart.getDate() - 7 * (n - 1))),
      to: ymd(lastEnd),
    }));
  }
  const lastFirst = new Date(y, includeCurrent ? m : m - 1, 1);
  const lastEnd = new Date(lastFirst.getFullYear(), lastFirst.getMonth() + 1, 0);
  const yearStart = new Date(y, 0, 1);
  // In January with the current month excluded there is no finished month this year yet: fall back to the current one.
  const ytdEnd = lastEnd < yearStart ? new Date(y, m + 1, 0) : lastEnd;
  return [
    ...[3, 6, 12].map((n) => ({
      value: `m${n}`,
      label: `Last ${n} months`,
      from: ymd(new Date(lastFirst.getFullYear(), lastFirst.getMonth() - (n - 1), 1)),
      to: ymd(lastEnd),
    })),
    { value: "ytd", label: "This year", from: ymd(yearStart), to: ymd(ytdEnd) },
  ];
}

/** The preset in `list` that exactly matches this range, or undefined. */
export const findPreset = (list: PeriodPreset[], from: string, to: string) => list.find((p) => p.from === from && p.to === to);

/** Which preset exactly matches this range today, or "custom" when none does (so the select can show the truth). */
export function matchPreset(from: string, to: string, now: Date = new Date()): RangePreset | "custom" | "" {
  if (!from && !to) return "";
  const hit = RANGE_PRESETS.find((p) => {
    const r = presetRange(p.value, now);
    return r.from === from && r.to === to;
  });
  return hit ? hit.value : "custom";
}

export function defaultFilters(now: Date = new Date()): CCFilters {
  // Nothing is pre-selected: no dates means all time.
  return { from: "", to: "", tz: browserTimeZone(), campaignIds: [], states: [], numberIds: [], vertical: "", agentId: "", direction: "", disposition: "" };
}

/** Query-string parameters for the API; empty filters are left out. Dates and ids only: nothing personal goes in a URL. */
export function filterParams(f: CCFilters, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = { tz: f.tz };
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.campaignIds.length) out.campaign_ids = f.campaignIds.join(",");
  if (f.states.length) out.states = f.states.join(",");
  if (f.numberIds.length) out.numbers = f.numberIds.join(",");
  if (f.vertical) out.vertical = f.vertical;
  if (f.agentId) out.agent_id = f.agentId;
  if (f.direction) out.direction = f.direction;
  if (f.disposition) out.disposition = f.disposition;
  for (const [k, v] of Object.entries(extra)) if (v) out[k] = v;
  return out;
}

/** True when `a` and `b` would produce the same report. */
export function sameFilters(a: CCFilters, b: CCFilters): boolean {
  return JSON.stringify(filterParams(a)) === JSON.stringify(filterParams(b));
}

/** The longest range the server accepts (backend MAX_RANGE_DAYS). */
export const MAX_RANGE_DAYS = 366;

/** Whole days from `from` to `to` inclusive (1 for the same day), or NaN if either isn't a date. */
export function rangeDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

/** A human message for an unusable date range, or null when it's fine. */
export function rangeError(from: string, to: string): string | null {
  if (!from || !to) return null; // an open end is fine: no start = all time, no end = today
  const days = rangeDays(from, to);
  if (Number.isNaN(days)) return "That date isn't valid.";
  if (days < 1) return "The start date must be on or before the end date.";
  if (days > MAX_RANGE_DAYS) return `Pick a range of at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

// ---------------------------------------------------------------------------------------------- colours + formatting

const GREEN: [number, number, number] = [25, 135, 84];
const AMBER: [number, number, number] = [245, 158, 11];
const RED: [number, number, number] = [220, 53, 69];

/** [r,g,b] for a drop rate on the ABSOLUTE 0-100 scale (green -> amber at 50 -> red), so the same % is the same colour everywhere. */
export function dropRateRgb(percentage: number | null | undefined): [number, number, number] {
  const p = Math.max(0, Math.min(100, Number.isFinite(percentage as number) ? (percentage as number) : 0));
  const mix = (a: number[], b: number[], t: number) => a.map((c, i) => Math.round(c + (b[i] - c) * t)) as [number, number, number];
  return p <= 50 ? mix(GREEN, AMBER, p / 50) : mix(AMBER, RED, (p - 50) / 50);
}

export function dropRateColor(percentage: number | null | undefined): string {
  const [r, g, b] = dropRateRgb(percentage);
  return `rgb(${r}, ${g}, ${b})`;
}

/** The same colour as a translucent background (for pills and heatmap cells that must keep their text readable). */
export function dropRateTint(percentage: number | null | undefined, alpha = 0.18): string {
  const [r, g, b] = dropRateRgb(percentage);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Heatmap ramp, pale mint (no/low drops) -> bright mint -> dark teal (most dropped). Stops are [drop %, [r,g,b]]. */
const HEAT_STOPS: [number, [number, number, number]][] = [
  [0, [233, 247, 242]],
  [25, [112, 219, 184]],
  [60, [74, 168, 150]],
  [100, [63, 127, 114]],
];

/** Colour of one heatmap cell for a drop rate on the absolute 0-100 scale. */
export function heatColor(pct: number): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [hi, hiRgb] = HEAT_STOPS[i];
    const [lo, loRgb] = HEAT_STOPS[i - 1];
    if (p <= hi) {
      const t = (p - lo) / (hi - lo);
      const [r, g, b] = loRgb.map((c, k) => Math.round(c + (hiRgb[k] - c) * t));
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  const [r, g, b] = HEAT_STOPS[HEAT_STOPS.length - 1][1];
  return `rgb(${r}, ${g}, ${b})`;
}

/** Whether a change is good news: for drop rate lower is better, for everything else higher is. */
export function trendIsGood(delta: number, higherIsBetter: boolean): boolean {
  return higherIsBetter ? delta >= 0 : delta <= 0;
}

export function trendColorClass(delta: number, higherIsBetter: boolean): string {
  return trendIsGood(delta, higherIsBetter) ? "text-success" : "text-destructive";
}

export const formatInt = (n: number | null | undefined) => (n ?? 0).toLocaleString();
export const formatPct = (n: number | null | undefined, digits = 1) => `${(n ?? 0).toFixed(digits)}%`;
export const formatMoney = (n: number | null | undefined) => `$${(n ?? 0).toFixed(2)}`;
/** "+3.2" / "-1.0" / "0.0": a signed delta with the sign always shown. */
export const formatDelta = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}`;

/**
 * Shorten a long axis label for display only (the full text stays in the tooltip and the data). As in the chart spec
 * the first `max` characters are kept and "…" is added, so a truncated label is max + 1 characters long.
 */
export function truncateLabel(s: string, max = 22): string {
  return s && s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Page URL for the drill-down behind one campaign, carrying the current dates/zone so the numbers match. */
export function reasonsUrl(campaignId: string, f: CCFilters): string {
  const p = new URLSearchParams({ campaign_id: campaignId, tz: f.tz });
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.direction) p.set("direction", f.direction);
  return `/dashboard/call-consumption/reasons?${p.toString()}`;
}

// ---------------------------------------------------------------------------------------------- API response shapes

export type OverviewKpis = {
  has_data: boolean;
  /** False when the window before this one had no calls: there is nothing to compare, so no change is shown. */
  has_previous: boolean;
  total_calls: number;
  total_calls_change_pct: number;
  consumption_pct: number;
  consumption_pct_point_change: number;
  drop_pct: number;
  drop_pct_point_change: number;
};

export type BreakdownKpi = {
  has_data: boolean;
  total_calls: number;
  consumed_calls: number;
  consumed_pct: number;
  dropped_calls: number;
  dropped_pct: number;
  segment_count: number;
  worst_segment_name: string | null;
  worst_segment_drop_rate: number | null;
  worst_segment_calls: number | null;
  cost_on_dropped: number;
};

export type HourlyKpis = {
  has_data: boolean;
  total_calls: number;
  overall_drop_pct: number;
  busiest_hour_label: string;
  busiest_hour_calls: number;
  date_range_label: string;
  risk_window_label: string;
  risk_window_drop_pct: number;
};

export type ReasonsResponse = {
  campaign_id: string;
  campaign_name: string | null;
  total_calls: number;
  consumed_calls: number;
  dropped_calls: number;
  drop_pct: number;
  reasons: { disposition: DropBucket; label: string; calls: number; pct_of_dropped: number }[];
  raw_reasons: { reason: string; disposition: DropBucket; label: string; calls: number; pct_of_dropped: number }[];
};

/** One direction's report: outbound by campaign, inbound by phone number (see the Inbound & Outbound page). */
export type DirectionReport = {
  direction: "inbound" | "outbound";
  has_data: boolean;
  segment_label: "Campaign" | "Number";
  kpis: OverviewKpis;
  rows: TreeRow[];
  total: TreeRow;
};

/** One direction's figures in the Overview's inbound-vs-outbound comparison. */
export type DirectionSummary = {
  has_data: boolean;
  total_calls: number;
  consumed_calls: number;
  consumption_pct: number;
  dropped_calls: number;
  drop_pct: number;
};
