/**
 * Types and pure helpers for the partner's user management (pages/dashboard/PartnerUsers.tsx and PartnerUserDetail.tsx):
 * the shapes of GET /partner/users[/{id}[/activity]], the filters the pages edit and the request they turn into, and the
 * small wording helpers. Nothing here knows about the platform's cost or profit: the server never sends them to a partner.
 * Dates are plain "YYYY-MM-DD" calendar days in the browser's time zone, which is also sent as `tz`.
 */
import { activityText, type ActivityKind } from "@/lib/partners";

export type UserStatus = "pending" | "verified";
export type UserSort = "signup" | "activity" | "calls" | "billed";
export type SortOrder = "asc" | "desc";

/** One referred account as the partner sees it. */
export type PartnerUser = {
  user_id: string;
  email: string;
  full_name: string;
  status: UserStatus;
  created_at: string;
  verified_at: string | null;
  agents: number;
  topups: number;
  topup_total: number;
  calls: number;
  minutes: number;
  billed: number;
  last_call: string | null;
  /** The latest of the signup, verification, an agent, a top-up or a call. */
  last_active: string;
};

export type Page<T> = { items: T[]; total: number; page: number; per_page: number; pages: number };

export type UserActivityItem = { id: string; kind: ActivityKind; at: string; detail: string | null };

export type UserFilters = {
  q: string;
  status: "" | UserStatus;
  signedFrom: string;
  signedTo: string;
  sort: UserSort;
  order: SortOrder;
  page: number;
};

export const DEFAULT_PER_PAGE = 25;
export const DEFAULT_USER_FILTERS: UserFilters = { q: "", status: "", signedFrom: "", signedTo: "", sort: "signup", order: "desc", page: 1 };

export const SORT_OPTIONS: { value: UserSort; label: string }[] = [
  { value: "signup", label: "Signup date" },
  { value: "activity", label: "Last activity" },
  { value: "calls", label: "Calls" },
  { value: "billed", label: "Billed" },
];

export const STATUS_OPTIONS: { value: "" | UserStatus; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "verified", label: "Verified" },
];

/** The kinds of activity in a user's history, in the order the filter shows them. */
export const ACTIVITY_KINDS: { value: ActivityKind; label: string }[] = [
  { value: "signup", label: "Signup" },
  { value: "verified", label: "Verified" },
  { value: "agent", label: "Agent created" },
  { value: "funds", label: "Top-up" },
  { value: "call", label: "Call" },
];

/** Why the signup dates cannot be used (null when they can). Either end may be empty. */
export function signupRangeError(from: string, to: string): string | null {
  return from && to && from > to ? "The start date must be on or before the end date." : null;
}

/** The server request for the user list; null while the signup dates contradict each other. */
export function buildUsersQuery(f: UserFilters, tz: string, perPage: number = DEFAULT_PER_PAGE): Record<string, string | undefined> | null {
  if (signupRangeError(f.signedFrom, f.signedTo)) return null;
  const q = f.q.trim();
  return {
    q: q || undefined, status: f.status || undefined, signed_from: f.signedFrom || undefined, signed_to: f.signedTo || undefined,
    sort: f.sort, order: f.order, page: String(f.page), per_page: String(perPage), tz,
  };
}

/** The same filters for the CSV: every match, not one page (the server ignores page and per_page for it). */
export function buildUsersCsvQuery(f: UserFilters, tz: string): Record<string, string | undefined> | null {
  const q = buildUsersQuery(f, tz);
  if (!q) return null;
  delete q.page;
  delete q.per_page;
  return q;
}

/** True when anything beyond the default sort narrows the list (so "Clear filters" has something to clear). */
export function hasFilters(f: UserFilters): boolean {
  return !!(f.q.trim() || f.status || f.signedFrom || f.signedTo);
}

/** "1–25 of 60", "0 users" for an empty list. */
export function rangeText(page: number, perPage: number, total: number): string {
  if (total === 0) return "0 users";
  const first = (page - 1) * perPage + 1;
  return `${first}–${Math.min(total, page * perPage)} of ${total}`;
}

/** A user's display name: the full name when they gave one, otherwise the email. */
export function userLabel(u: Pick<PartnerUser, "email" | "full_name">): string {
  return u.full_name.trim() || u.email;
}

export type ActivityFilters = { kinds: ActivityKind[]; start: string; end: string; page: number };
export const DEFAULT_ACTIVITY_FILTERS: ActivityFilters = { kinds: [], start: "", end: "", page: 1 };

/** The request for a user's activity; `kinds` empty means every kind. Null while the dates contradict each other. */
export function buildActivityQuery(f: ActivityFilters, tz: string, perPage: number = DEFAULT_PER_PAGE): Record<string, string | string[] | undefined> | null {
  if (signupRangeError(f.start, f.end)) return null;
  return {
    kind: f.kinds.length && f.kinds.length < ACTIVITY_KINDS.length ? f.kinds : undefined,
    start: f.start || undefined, end: f.end || undefined, page: String(f.page), per_page: String(perPage), tz,
  };
}

/** Adds or removes one kind from the selection, keeping the filter's own order. */
export function toggleKind(kinds: ActivityKind[], kind: ActivityKind): ActivityKind[] {
  const next = kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind];
  return ACTIVITY_KINDS.map((k) => k.value).filter((k) => next.includes(k));
}

/** File name of the users CSV. */
export function usersFilename(): string {
  return "referred-users.csv";
}

/** One line of a user's history, e.g. "Added $25.00 in funds" (the user is the page's subject, so there is no name in it). */
export function historyText(item: Pick<UserActivityItem, "kind" | "detail">): string {
  const t = activityText(item);
  return t.charAt(0).toUpperCase() + t.slice(1);
}
