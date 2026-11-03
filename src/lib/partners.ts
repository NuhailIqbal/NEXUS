/**
 * Referral partner types and small pure helpers, shared by the partner's own page
 * (pages/dashboard/Partner.tsx) and the admin portal (components/admin/PartnersAdmin.tsx).
 * The shapes mirror the /partner/* and /admin/partners/* responses (backend/routers/partners.py).
 */

export type CommissionType = "percent" | "fixed";

/** What a partner may see in totals: never the platform's cost, profit or net (those are admin-only). */
export type PartnerTotals = {
  signups: number;
  verified: number;
  calls: number;
  billed: number;
  commission: number;
};

/** Admin totals add what the platform paid its providers and what is left after the commission. */
export type AdminPartnerTotals = PartnerTotals & { platform_cost: number; profit: number; net_profit: number };

export type PartnerInfo = {
  id: string;
  name: string;
  email: string;
  code: string;
  status: "active" | "paused";
  /** Admin responses only (private admin notes); never sent to the partner. */
  notes?: string;
  commission_type: CommissionType;
  commission_value: number;
  commission_label: string;
  referral_path: string;
  created_at?: string;
};

export type PartnerSignup = {
  user_id: string;
  email: string;
  full_name: string;
  status: "pending" | "verified";
  created_at: string;
  verified_at: string | null;
  calls: number;
  minutes: number;
  billed: number;
  last_call: string | null;
  /** Admin responses only. */
  platform_cost?: number;
  profit?: number;
};

export type ActivityKind = "signup" | "verified" | "funds" | "agent" | "call";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  at: string;
  detail: string | null;
  user_id: string;
  email: string;
  partner_id: string;
  partner_name: string;
};

/** The full link a partner shares: the app's own origin plus the path the API returns (/register?ref=CODE). */
export function referralUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

/** One line describing what a referred user did, e.g. "added $25.00 in funds". */
export function activityText(item: Pick<ActivityItem, "kind" | "detail">): string {
  const d = item.detail?.trim();
  switch (item.kind) {
    case "signup": return "signed up";
    case "verified": return "verified their email";
    case "funds": return d ? `added $${Number(d).toFixed(2)} in funds` : "added funds";
    case "agent": return d ? `created the agent "${d}"` : "created an agent";
    case "call": return d || "made a call";
    default: return "did something";
  }
}

/** "5m ago", "2h ago", "3d ago"; "just now" under 45 seconds. A bad or missing date gives an empty string. */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Plain-English explanation of how a commission is earned, shown next to the rate. */
export function commissionExplainer(type: CommissionType): string {
  return type === "fixed"
    ? "Paid once for every referred account that verifies its email."
    : "A share of the profit on everything your referred accounts spend on calls, for as long as they use it.";
}

/** Parses the commission field of the admin form; null when it is not a usable number for that type. */
export function parseCommission(type: CommissionType, raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  if (type === "percent" && n > 100) return null;
  if (type === "fixed" && n > 10000) return null;
  return Math.round(n * 100) / 100;
}
