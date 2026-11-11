import { describe, expect, it } from "vitest";
import {
  ACTIVITY_KINDS, DEFAULT_ACTIVITY_FILTERS, DEFAULT_USER_FILTERS, buildActivityQuery, buildUsersCsvQuery, buildUsersQuery, hasFilters, historyText,
  rangeText, signupRangeError, toggleKind, userLabel, type UserFilters,
} from "./partnerUsers";

const f = (over: Partial<UserFilters> = {}): UserFilters => ({ ...DEFAULT_USER_FILTERS, ...over });

describe("buildUsersQuery", () => {
  it("sends only what narrows the list, plus the sort, the page and the time zone", () => {
    expect(buildUsersQuery(f(), "Asia/Karachi")).toEqual({
      q: undefined, status: undefined, signed_from: undefined, signed_to: undefined, sort: "signup", order: "desc", page: "1", per_page: "25", tz: "Asia/Karachi",
    });
    expect(buildUsersQuery(f({ q: "  alice ", status: "verified", signedFrom: "2026-10-01", signedTo: "2026-10-31", sort: "billed", order: "asc", page: 3 }), "UTC", 10)).toEqual({
      q: "alice", status: "verified", signed_from: "2026-10-01", signed_to: "2026-10-31", sort: "billed", order: "asc", page: "3", per_page: "10", tz: "UTC",
    });
  });
  it("sends nothing while the signup dates contradict each other", () => {
    expect(buildUsersQuery(f({ signedFrom: "2026-11-02", signedTo: "2026-10-01" }), "UTC")).toBeNull();
    expect(buildUsersCsvQuery(f({ signedFrom: "2026-11-02", signedTo: "2026-10-01" }), "UTC")).toBeNull();
  });
  it("accepts a range open at one end", () => {
    expect(buildUsersQuery(f({ signedFrom: "2026-10-01" }), "UTC")).toMatchObject({ signed_from: "2026-10-01", signed_to: undefined });
    expect(buildUsersQuery(f({ signedTo: "2026-10-01" }), "UTC")).toMatchObject({ signed_from: undefined, signed_to: "2026-10-01" });
  });
  it("builds the CSV request from the same filters but never a page", () => {
    const q = buildUsersCsvQuery(f({ status: "pending", q: "bob", page: 4 }), "UTC")!;
    expect(q).toMatchObject({ status: "pending", q: "bob", sort: "signup", order: "desc", tz: "UTC" });
    expect(q).not.toHaveProperty("page");
    expect(q).not.toHaveProperty("per_page");
  });
});

describe("signupRangeError and hasFilters", () => {
  it("explains only a start after the end", () => {
    expect(signupRangeError("2026-10-05", "2026-10-01")).toMatch(/on or before/);
    expect(signupRangeError("2026-10-01", "2026-10-01")).toBeNull();
    expect(signupRangeError("", "2026-10-01")).toBeNull();
    expect(signupRangeError("2026-10-01", "")).toBeNull();
  });
  it("counts search, status and dates as filters but not the sort or the page", () => {
    expect(hasFilters(f())).toBe(false);
    expect(hasFilters(f({ sort: "calls", order: "asc", page: 2 }))).toBe(false);
    expect(hasFilters(f({ q: "  " }))).toBe(false);
    expect(hasFilters(f({ q: "a" }))).toBe(true);
    expect(hasFilters(f({ status: "pending" }))).toBe(true);
    expect(hasFilters(f({ signedTo: "2026-10-01" }))).toBe(true);
  });
});

describe("rangeText and userLabel", () => {
  it("writes which rows a page shows", () => {
    expect(rangeText(1, 25, 60)).toBe("1–25 of 60");
    expect(rangeText(3, 25, 60)).toBe("51–60 of 60");
    expect(rangeText(1, 25, 1)).toBe("1–1 of 1");
    expect(rangeText(1, 25, 0)).toBe("0 users");
  });
  it("names a user by their full name, else their email", () => {
    expect(userLabel({ email: "a@x.test", full_name: "Alice A" })).toBe("Alice A");
    expect(userLabel({ email: "a@x.test", full_name: "  " })).toBe("a@x.test");
  });
});

describe("activity filters", () => {
  it("asks for no kinds at all when none, or every one, is selected", () => {
    expect(buildActivityQuery(DEFAULT_ACTIVITY_FILTERS, "UTC")).toEqual({ kind: undefined, start: undefined, end: undefined, page: "1", per_page: "25", tz: "UTC" });
    expect(buildActivityQuery({ ...DEFAULT_ACTIVITY_FILTERS, kinds: ACTIVITY_KINDS.map((k) => k.value) }, "UTC")!.kind).toBeUndefined();
  });
  it("sends the selected kinds, the dates and the page", () => {
    expect(buildActivityQuery({ kinds: ["call", "funds"], start: "2026-10-01", end: "2026-10-31", page: 2 }, "UTC", 10)).toEqual({
      kind: ["call", "funds"], start: "2026-10-01", end: "2026-10-31", page: "2", per_page: "10", tz: "UTC",
    });
    expect(buildActivityQuery({ ...DEFAULT_ACTIVITY_FILTERS, start: "2026-11-01", end: "2026-10-01" }, "UTC")).toBeNull();
  });
  it("toggles a kind on and off, always in the filter's own order", () => {
    expect(toggleKind([], "call")).toEqual(["call"]);
    expect(toggleKind(["call"], "signup")).toEqual(["signup", "call"]);
    expect(toggleKind(["signup", "call"], "signup")).toEqual(["call"]);
  });
  it("words one history line without a name", () => {
    expect(historyText({ kind: "signup", detail: null })).toBe("Signed up");
    expect(historyText({ kind: "funds", detail: "25.00" })).toBe("Added $25.00 in funds");
    expect(historyText({ kind: "agent", detail: "Sales Bot" })).toBe('Created the agent "Sales Bot"');
    expect(historyText({ kind: "call", detail: "Outbound call · Completed · 60s" })).toBe("Outbound call · Completed · 60s");
  });
});
