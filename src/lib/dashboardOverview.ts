/**
 * Types and small pure helpers for the dashboard home (pages/dashboard/DashboardIndex.tsx, components/dashboard-home/*).
 * The numbers come from GET /dashboard/overview (services/dashboard_overview.py); this file only shapes them for the
 * screen. A figure the server could not work out (nothing to divide by, nothing finished) arrives as null and is shown
 * as "—", never as 0.
 */
import { BUCKET_LABELS, DROP_BUCKETS, ymd } from "@/lib/callConsumption";
import { stallMessage } from "@/lib/dialingStrategy";

export type RangeKey = "today" | "7d" | "30d" | "custom";

export const RANGES: { value: RangeKey; label: string; previous: string }[] = [
  { value: "today", label: "Today", previous: "yesterday" },
  { value: "7d", label: "7 days", previous: "the 7 days before" },
  { value: "30d", label: "30 days", previous: "the 30 days before" },
  // Any From..To the viewer picks; its "previous" is worked out from the length (see previousLabel).
  { value: "custom", label: "Custom", previous: "the period before" },
];

/** The date pair of a custom range (YYYY-MM-DD). */
export type CustomRange = { from: string; to: string };

export type CustomPreset = CustomRange & { key: string; label: string };

/**
 * The quick picks shown with the Custom range: Yesterday, Week / Month / Year to Date, Current Month, Last Month, as
 * From..To dates in the viewer's local calendar. Weeks start on Sunday, like the weekly reports. "Current Month" ends on
 * the month's last day; the server counts only up to today.
 */
export function customPresets(now: Date = new Date()): CustomPreset[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const at = (year: number, month: number, day: number) => ymd(new Date(year, month, day));   // Date normalises overflow (day 0 = last of the month before)
  const today = at(y, m, d);
  return [
    { key: "yesterday", label: "Yesterday", from: at(y, m, d - 1), to: at(y, m, d - 1) },
    { key: "week", label: "Week to Date", from: at(y, m, d - now.getDay()), to: today },
    { key: "month", label: "Month to Date", from: at(y, m, 1), to: today },
    { key: "year", label: "Year to Date", from: at(y, 0, 1), to: today },
    { key: "current-month", label: "Current Month", from: at(y, m, 1), to: at(y, m + 1, 0) },
    { key: "last-month", label: "Last Month", from: at(y, m - 1, 1), to: at(y, m, 0) },
  ];
}

/** What a change is measured against: "yesterday", "the 7 days before", ... A custom range names its own length. */
export function previousLabel(rangeKey: RangeKey, days?: number): string {
  if (rangeKey === "custom" && days) return days === 1 ? "the day before" : `the ${days} days before`;
  return RANGES.find((r) => r.value === rangeKey)?.previous ?? "the previous period";
}

export type Tile = { value: number; previous: number; change_pct: number | null };
export type RatioTile = { value: number | null; previous: number | null; change_pct: number | null };

export type Tiles = {
  has_data: boolean;
  /** False when the range before this one had no calls: nothing to compare, so no change is shown. */
  has_previous: boolean;
  calls: Tile;
  answered_rate: {
    value: number | null; answered: number; finished: number; previous: number | null; change_pts: number | null;
    /** The finished calls nobody answered, by why (answered + not_answered.total = finished). */
    not_answered: { total: number; buckets: Record<string, number> };
  };
  qualified_leads: Tile;
  leads: Tile;
  minutes: Tile;
  spend: Tile;
  cost_per_qualified_lead: RatioTile;
};

export type TrendPoint = {
  date: string; calls: number; qualified_leads: number; leads: number;
  spend: number; minutes: number; answered: number; finished: number;
};

/** A running campaign, as far as the needs-attention list cares: what the dialer says about it. */
export type CampaignItem = {
  id: string;
  name: string;
  status: "Active" | "Paused";
  state: string | null;
  stall_reason: string | null;
  errors: number;
  last_error: string | null;
};

export type Setup = { agent: boolean; phone: boolean; campaign: boolean; receptionist: boolean; calls: boolean; complete: boolean };

/** What the account has set up (outbound campaigns are counted in `campaigns.counts`). */
export type Inventory = {
  agents: { total: number; active: number };
  receptionists: { total: number; active: number };
};

/** One line of a "Top ..." table (campaign, agent or inbound receptionist). cost_per_qualified_lead is null with no qualified lead. */
export type TopRow = {
  id: string;
  name: string;
  calls: number;
  leads: number;
  qualified_leads: number;
  spend: number;
  cost_per_qualified_lead: number | null;
};

/** The three ranked tables, best first (most qualified leads, then most calls). */
export type Tops = { campaigns: TopRow[]; agents: TopRow[]; receptionists: TopRow[] };

/** One hour of the hour-by-hour chart. The counts are null for an hour that has not happened yet (the line stops at now). */
export type HourPoint = { date: string; hour: number; calls: number | null; qualified_leads: number | null; leads: number | null };

/** What the main chart draws: every hour of the range (a day or two) or every day (see `trend`). */
export type ChartInfo = { granularity: "hour" | "day"; hourly: HourPoint[] };

/** GET /dashboard/live: the part of the page that must stay fresh whatever range is chosen. */
export type LiveData = {
  running_now: { total: number; outbound: number; inbound: number };
  calls_today: { total: number; answered: number };
  as_of: string;
};

/** How often the live strip asks again. */
export const LIVE_REFRESH_MS = 10_000;

export type DashboardOverview = {
  range: RangeKey;
  from: string;
  to: string;
  tiles: Tiles;
  trend: TrendPoint[];
  campaigns: { counts: { active: number; paused: number; inactive: number }; items: CampaignItem[] };
  inventory: Inventory;
  chart: ChartInfo;
  tops: Tops;
  setup: Setup;
};

/**
 * Chart colours for the two series on the home page, one pair per theme. Validated with the dataviz palette checker
 * (lightness band, chroma, colour-blind separation and contrast against the card surface all pass), so identity never
 * depends on telling green from violet by hue alone: the legend and the tooltip name them as well.
 */
export const CHART_COLORS = {
  dark: { calls: "#2DA876", qualified: "#8466EE" },
  light: { calls: "#2C9664", qualified: "#6F35D4" },
} as const;

export const ROUTES = {
  campaigns: "/dashboard/telephony/campaigns",
  conversations: "/dashboard/conversations",
  agents: "/dashboard/ai-agents",
  receptionists: "/dashboard/telephony/inbound",
  leadRoi: "/dashboard/call-consumption/lead-roi",
  consumption: "/dashboard/call-consumption/overview",
  quickSetup: "/dashboard/quick-setup",
} as const;

/** A change as "+12.5% vs yesterday", or null when there is nothing to compare. */
export function changeLine(change: number | null | undefined, unit: string, rangeKey: RangeKey, days?: number): string | null {
  if (change === null || change === undefined) return null;
  return `${change > 0 ? "+" : ""}${change.toFixed(1)}${unit} vs ${previousLabel(rangeKey, days)}`;
}

/** "Oct 26" from "2026-10-26", read as a calendar date (no time zone shift). */
export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Minutes as "3.0 min", "42 min" or "1h 05m". */
export function formatMinutes(minutes: number | null | undefined): string {
  const m = minutes ?? 0;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rest = Math.round(m - h * 60);
    // 59.6 minutes past the hour rounds to 60: carry it so we never print "1h 60m".
    return rest === 60 ? `${h + 1}h 00m` : `${h}h ${String(rest).padStart(2, "0")}m`;
  }
  return `${m >= 10 ? Math.round(m) : m.toFixed(1)} min`;
}

/** One thing that needs a person's attention, with where to go. */
export type Alert = { key: string; level: "error" | "warning"; text: string; to: string; action: string };

/** Everything that is wrong with a running campaign right now. Empty = all well. */
export function buildAlerts(d: Pick<DashboardOverview, "campaigns">): Alert[] {
  const out: Alert[] = [];
  for (const c of d.campaigns.items) {
    if (c.status !== "Active") continue;
    const stall = stallMessage(c.stall_reason);
    if (stall) {
      out.push({ key: `stall-${c.id}`, level: "warning", text: `${c.name}: ${stall}`, to: ROUTES.campaigns, action: "Open campaigns" });
    } else if (c.errors > 0 && c.last_error) {
      out.push({ key: `error-${c.id}`, level: "warning", text: `${c.name}: some calls could not be placed (${c.last_error.replace(/vapi/gi, "voice service")}).`, to: ROUTES.campaigns, action: "Open campaigns" });
    }
  }
  return out;
}

export type SetupStep = { key: string; title: string; description: string; done: boolean; href: string };

/** The three first steps (the full list is on the Quick Setup page). A campaign OR a receptionist satisfies the last. */
export function setupSteps(s: Setup): SetupStep[] {
  return [
    { key: "agent", title: "Create an AI agent", description: "Tell it who it is calling for and what to say.", done: s.agent, href: "/dashboard/ai-agents/create" },
    { key: "phone", title: "Get a phone number", description: "The number your calls go out from, or customers ring.", done: s.phone, href: "/dashboard/telephony/phone-numbers" },
    { key: "calls", title: "Start calling", description: "Launch a campaign, or set up an AI receptionist for incoming calls.", done: s.campaign || s.receptionist, href: ROUTES.campaigns },
  ];
}

/** "Good morning" / "Good afternoon" / "Good evening" for the viewer's local hour. */
export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The first word of a person's name, capitalised ("pat smith" -> "Pat"); "" when there is none. */
export function firstName(name: string | null | undefined): string {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return word ? word[0].toUpperCase() + word.slice(1) : "";
}

/** One line under the greeting: how many campaigns are running and whether anything needs a look. */
export function statusLine(d: Pick<DashboardOverview, "campaigns" | "setup">, alertCount: number): string {
  if (!d.setup.complete) return "Finish setting up and your numbers will appear here.";
  const running = d.campaigns.counts.active;
  const campaigns = running === 0 ? "No campaigns running" : `${running} campaign${running === 1 ? "" : "s"} running`;
  return `${campaigns} · ${alertCount === 0 ? "everything looks good" : `${alertCount} thing${alertCount === 1 ? "" : "s"} need${alertCount === 1 ? "s" : ""} a look`}`;
}

/** A change split for a pill and its caption: {text: "+12.5%", caption: "vs yesterday", delta}, or null with nothing to compare. */
export function changeParts(change: number | null | undefined, unit: string, rangeKey: RangeKey, days?: number) {
  if (change === null || change === undefined) return null;
  return { delta: change, text: `${change > 0 ? "+" : ""}${change.toFixed(1)}${unit}`, caption: `vs ${previousLabel(rangeKey, days)}` };
}

/** One day's answered rate in percent, or null on a day with nothing finished (a gap, never a fake 0%). */
export const dayRate = (p: Pick<TrendPoint, "answered" | "finished">): number | null =>
  p.finished > 0 ? Math.round((p.answered / p.finished) * 1000) / 10 : null;

/** One day's cost per qualified lead, or null when nobody qualified that day. */
export const dayCostPerQualified = (p: Pick<TrendPoint, "spend" | "qualified_leads">): number | null =>
  p.qualified_leads > 0 ? Math.round((p.spend / p.qualified_leads) * 100) / 100 : null;

export type FunnelStage = { key: string; label: string; hint: string; value: number; pctOfCalls: number };

/** Calls -> answered -> leads -> qualified, each as a share of all calls (a bar's width). Empty with no calls. */
export function funnelStages(t: Tiles): FunnelStage[] {
  const calls = t.calls.value;
  if (calls <= 0) return [];
  const pct = (n: number) => Math.min(100, Math.round((n / calls) * 1000) / 10);
  const rows: [string, string, string, number][] = [
    ["calls", "Calls made", "Every call placed or received", calls],
    ["answered", "Answered", "A person picked up and talked", t.answered_rate.answered],
    ["leads", "Leads", "Qualified, asked for a callback or booked a meeting", t.leads.value],
    ["qualified", "Qualified", "Handed to a human", t.qualified_leads.value],
  ];
  return rows.map(([key, label, hint, value]) => ({ key, label, hint, value, pctOfCalls: pct(value) }));
}

/** Under "Calls running now": the split by direction, or a plain note when nothing is running. */
export function runningSub(r: LiveData["running_now"]): string {
  if (r.total === 0) return "none right now";
  return [r.outbound > 0 ? `${r.outbound} outbound` : null, r.inbound > 0 ? `${r.inbound} inbound` : null].filter(Boolean).join(" · ");
}

/** "12 AM", "1 AM" ... "12 PM", "1 PM" ... "11 PM" for an hour 0-23. */
export function hourLabel(hour: number): string {
  const h12 = hour % 12 || 12;
  return `${h12} ${hour < 12 ? "AM" : "PM"}`;
}

/** One point of the main chart: what the axis and the tooltip say, and the two numbers (null = not yet happened). */
export type ChartPoint = { label: string; tip: string; calls: number | null; qualified_leads: number | null };

/**
 * The main chart's points for an overview: hour by hour when the server says so, day by day otherwise. A one-day range
 * labels its axis with the hour ("3 PM"); a two-day range labels midnight with the date ("Oct 26") so the days can be told
 * apart. The tooltip always spells the moment out ("Oct 27, 2 PM – 3 PM").
 */
export function chartPoints(d: Pick<DashboardOverview, "chart" | "trend">): ChartPoint[] {
  if (d.chart.granularity === "hour") {
    const days = new Set(d.chart.hourly.map((p) => p.date)).size;
    return d.chart.hourly.map((p) => ({
      label: days > 1 && p.hour === 0 ? dayLabel(p.date) : hourLabel(p.hour),
      tip: `${dayLabel(p.date)}, ${hourLabel(p.hour)} – ${hourLabel((p.hour + 1) % 24)}`,
      calls: p.calls,
      qualified_leads: p.qualified_leads,
    }));
  }
  return d.trend.map((p) => ({ label: dayLabel(p.date), tip: dayLabel(p.date), calls: p.calls, qualified_leads: p.qualified_leads }));
}

/** True when nothing happened in the charted period (a null hour has not happened yet, so it counts as nothing). */
export const chartIsEmpty = (points: ChartPoint[]) => points.every((p) => (p.calls ?? 0) === 0);

export type NotAnsweredItem = { key: string; label: string; count: number };

/**
 * Where the calls that were not answered went: each reason that happened (biggest first, ties in Call Consumption's
 * order) with its label, plus "Not finished yet" for calls that were placed but have no result yet (still ringing or
 * in progress). `total` is only the finished-and-unanswered calls; the unfinished ones are listed but not in it.
 */
export function notAnsweredBreakdown(t: Tiles): { total: number; items: NotAnsweredItem[] } {
  const na = t.answered_rate.not_answered;
  const items: NotAnsweredItem[] = DROP_BUCKETS
    .map((key) => ({ key: key as string, label: BUCKET_LABELS[key], count: na.buckets[key] ?? 0 }))
    .filter((i) => i.count > 0)
    .sort((a, b) => b.count - a.count);          // stable: equal counts stay in DROP_BUCKETS order
  const unfinished = t.calls.value - t.answered_rate.finished;
  if (unfinished > 0) items.push({ key: "unfinished", label: "Not finished yet", count: unfinished });
  return { total: na.total, items };
}
