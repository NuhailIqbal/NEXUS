/**
 * The referral partner's own console (/partner/*): its routes, its sidebar and the small decisions its login and layout make.
 * It is separate from the customer dashboard (/dashboard/*) but uses the same accounts and the same session: a partner is an
 * ordinary login that an admin linked to a partner row, so the console signs in through the same endpoint and then checks
 * GET /partner/me. Everything the console shows is scoped to that partner row on the server.
 */
export const PARTNER_HOME = "/partner";
export const PARTNER_LOGIN = "/partner/login";
export const PARTNER_USERS = "/partner/users";

/** The console's sidebar. `end` limits a link to its exact path (the overview is a prefix of every other page). */
export const PARTNER_NAV: { label: string; to: string; end?: boolean }[] = [
  { label: "Overview", to: PARTNER_HOME, end: true },
  { label: "My Users", to: PARTNER_USERS },
];

/** What GET /partner/me answers (null while it has not): the fields the console reads. */
export type PartnerMe = { is_partner: boolean; partner: { name: string; code: string; status: "active" | "paused" } | null };

/** The console's access states: still checking, allowed in, or not a partner at all. */
export type PartnerAccess = "checking" | "partner" | "not-partner" | "unknown";

/** Maps the answer of GET /partner/me to an access state; a failed request (null) is "unknown", never "not-partner". */
export function partnerAccess(me: PartnerMe | null | undefined): Exclude<PartnerAccess, "checking"> {
  if (!me) return "unknown";
  return me.is_partner && me.partner ? "partner" : "not-partner";
}

/** Shown on the partner sign-in when a valid account is not a partner. */
export const NOT_A_PARTNER_MESSAGE =
  "This account is not set up as a referral partner. If you are a customer, use the regular sign-in.";

/** The /dashboard/partner... addresses of the console before it had its own section, mapped to the /partner... ones. */
export function legacyPartnerPath(pathname: string): string | null {
  const m = /^\/dashboard\/partner(\/.*)?$/.exec(pathname);
  return m ? `${PARTNER_HOME}${m[1] ?? ""}`.replace(/\/+$/, "") || PARTNER_HOME : null;
}
