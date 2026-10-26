/**
 * Shared types and small pure helpers for the "Cost per lead & ROI" report (pages/dashboard/lead-roi/*,
 * components/lead-roi/*). The numbers come from the backend (services/lead_roi.py); this file only formats them and
 * turns the value form into the request body.
 *
 * Vocabulary: a LEAD is a call that was handed to a human (qualified), or where the person asked for a callback or the
 * agent booked a meeting. A QUALIFIED lead is the handed-over kind. A ratio the server could not work out (nothing to
 * divide by, no value set) arrives as null and is shown as "—", never as 0.
 */
import { formatInt } from "@/lib/callConsumption";

export const LEAD_ROI_PATH = "/lead-roi";

/** One slice of the report (a campaign, a week, the Total). null = not available (no leads / no value / no spend). */
export type LeadRoiRow = {
  calls: number;
  spend: number;
  leads: number;
  qualified_leads: number;
  cost_per_lead: number | null;
  cost_per_qualified_lead: number | null;
  revenue: number | null;
  profit: number | null;
  roi_pct: number | null;
};

export type CampaignRow = LeadRoiRow & {
  key: string;
  name: string;
  value_per_qualified_lead: number | null;
  value_per_lead: number | null;
  value_source: "campaign" | "account" | null;
};

/** One inbound phone number (the "By phone number" table). key "" = calls whose number is gone. */
export type NumberRow = LeadRoiRow & { key: string; name: string };
export type NumberReport = { has_data: boolean; has_value: boolean; rows: NumberRow[]; total: LeadRoiRow & { name: string } };

export type PeriodRow = LeadRoiRow & { key: string; name: string; start_date: string; end_date: string; partial: boolean };
export type PeriodReport = {
  has_data: boolean; has_value: boolean; granularity: "weekly" | "monthly"; rows: PeriodRow[]; total: LeadRoiRow & { name: string };
};

export type CampaignReport = { has_data: boolean; has_value: boolean; rows: CampaignRow[]; total: LeadRoiRow & { name: string } };

export type LeadRoiKpis = LeadRoiRow & {
  has_data: boolean;
  /** False when the window before this one had no calls: nothing to compare, so no change is shown. */
  has_previous: boolean;
  has_value: boolean;
  /** Campaigns that made leads but have no value: their revenue is counted as nothing. */
  unvalued_campaigns: number;
  spend_change_pct: number | null;
  leads_change_pct: number | null;
  qualified_leads_change_pct: number | null;
  cost_per_lead_change_pct: number | null;
  cost_per_qualified_lead_change_pct: number | null;
  /** ROI moves in percentage points. */
  roi_point_change: number | null;
};

export type LeadValues = {
  account: { value_per_qualified_lead: number | null; value_per_lead: number | null };
  campaigns: { campaign_id: string; name: string; value_per_qualified_lead: number | null; value_per_lead: number | null }[];
};

export const NOT_AVAILABLE = "—";

/** "$1.67", or "—" when the figure is not available. */
export const moneyOrDash = (n: number | null | undefined) =>
  n === null || n === undefined ? NOT_AVAILABLE : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "+4,300.0%" is noise: ROI is shown as "4,300%" (whole percent) with its sign only when it is a loss. */
export const roiOrDash = (n: number | null | undefined) =>
  n === null || n === undefined ? NOT_AVAILABLE : `${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}%`;

/** A relative change in percent as "+12.5%", or null when there is nothing to compare. */
export const changeText = (n: number | null | undefined, unit = "%") =>
  n === null || n === undefined ? null : `${n > 0 ? "+" : ""}${n.toFixed(1)}${unit}`;

/** How many of the leads were qualified, e.g. "4 qualified". */
export const leadsSub = (r: Pick<LeadRoiRow, "leads" | "qualified_leads">) => `${formatInt(r.qualified_leads)} qualified`;

// ---------------------------------------------------------------------------------------------- value form

export const MAX_VALUE = 10_000_000;

/** What the person typed -> a number, null for "left blank", or an error sentence. */
export function parseValueInput(text: string, label: string): { value: number | null; error: string | null } {
  const t = text.trim().replace(/[$,\s]/g, "");
  if (t === "") return { value: null, error: null };
  if (!/^\d*\.?\d+$|^\d+\.$/.test(t)) return { value: null, error: `${label} must be a number, like 50 or 12.50.` };
  const n = Number(t);
  if (n > MAX_VALUE) return { value: null, error: `${label} can be at most ${MAX_VALUE.toLocaleString()}.` };
  return { value: Math.round(n * 100) / 100, error: null };
}

/** A stored value as it is shown in an input: "" when not set. */
export const valueText = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
