import { describe, expect, it } from "vitest";
import {
  activityText, balanceStatus, checkPayoutAmount, commissionExplainer, parseCommission, payoutDate, referralUrl, timeAgo, todayISO,
} from "./partners";

describe("referralUrl", () => {
  it("joins the origin and the path without a double slash", () => {
    expect(referralUrl("https://edmnexus.ai/", "/register?ref=ABC12345")).toBe("https://edmnexus.ai/register?ref=ABC12345");
    expect(referralUrl("http://localhost:8080", "/register?ref=X")).toBe("http://localhost:8080/register?ref=X");
  });
});

describe("activityText", () => {
  it("describes each kind of action", () => {
    expect(activityText({ kind: "signup", detail: null })).toBe("signed up");
    expect(activityText({ kind: "verified", detail: null })).toBe("verified their email");
    expect(activityText({ kind: "funds", detail: "25.5" })).toBe("added $25.50 in funds");
    expect(activityText({ kind: "agent", detail: "Sales Bot" })).toBe('created the agent "Sales Bot"');
    expect(activityText({ kind: "call", detail: "Outbound call · Completed · 60s" })).toBe("Outbound call · Completed · 60s");
  });
  it("falls back when there is no detail", () => {
    expect(activityText({ kind: "funds", detail: null })).toBe("added funds");
    expect(activityText({ kind: "agent", detail: "  " })).toBe("created an agent");
    expect(activityText({ kind: "call", detail: null })).toBe("made a call");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-02T12:00:00Z").getTime();
  it("rounds to the nearest sensible unit", () => {
    expect(timeAgo("2026-11-02T11:59:50Z", now)).toBe("just now");
    expect(timeAgo("2026-11-02T11:55:00Z", now)).toBe("5m ago");
    expect(timeAgo("2026-11-02T10:00:00Z", now)).toBe("2h ago");
    expect(timeAgo("2026-10-30T12:00:00Z", now)).toBe("3d ago");
  });
  it("never goes negative for a clock-skewed future time, and ignores bad input", () => {
    expect(timeAgo("2026-11-02T12:05:00Z", now)).toBe("just now");
    expect(timeAgo("nonsense", now)).toBe("");
    expect(timeAgo(null, now)).toBe("");
  });
});

describe("parseCommission", () => {
  it("accepts a number inside the limits and rounds to cents", () => {
    expect(parseCommission("percent", "20")).toBe(20);
    expect(parseCommission("percent", "12.345")).toBe(12.35);
    expect(parseCommission("fixed", "5")).toBe(5);
    expect(parseCommission("percent", "0")).toBe(0);
  });
  it("rejects blanks, negatives, text and out-of-range values", () => {
    expect(parseCommission("percent", "")).toBeNull();
    expect(parseCommission("percent", "-1")).toBeNull();
    expect(parseCommission("percent", "abc")).toBeNull();
    expect(parseCommission("percent", "101")).toBeNull();
    expect(parseCommission("fixed", "10001")).toBeNull();
  });
});

describe("balanceStatus", () => {
  it("tells owed, settled and overpaid apart, ignoring float dust below a cent", () => {
    expect(balanceStatus(4)).toBe("owed");
    expect(balanceStatus(0.01)).toBe("owed");
    expect(balanceStatus(0)).toBe("settled");
    expect(balanceStatus(0.004)).toBe("settled");
    expect(balanceStatus(-0.004)).toBe("settled");
    expect(balanceStatus(-2)).toBe("overpaid");
  });
});

describe("checkPayoutAmount", () => {
  it("accepts an amount up to what is owed, rounded to cents, with a $ or thousands separators", () => {
    expect(checkPayoutAmount("4.00", 4)).toEqual({ value: 4, error: null });
    expect(checkPayoutAmount(" $1,250.5 ", 2000)).toEqual({ value: 1250.5, error: null });
    expect(checkPayoutAmount("0.335", 4).value).toBe(0.34);
    expect(checkPayoutAmount("0.01", 0.01).error).toBeNull();
  });
  it("refuses blanks, text, zero and negatives", () => {
    expect(checkPayoutAmount("", 4).error).toMatch(/Enter the amount/);
    expect(checkPayoutAmount("abc", 4).error).toMatch(/number/);
    expect(checkPayoutAmount("0", 4).error).toMatch(/more than \$0/);
    expect(checkPayoutAmount("-3", 4).error).toMatch(/more than \$0/);
    expect(checkPayoutAmount("Infinity", 4).error).toMatch(/number/);
  });
  it("refuses more than is owed (naming the balance), and anything when nothing is owed", () => {
    expect(checkPayoutAmount("4.01", 4)).toEqual({ value: null, error: "That is more than what is still owed ($4.00)." });
    expect(checkPayoutAmount("1", 0).error).toMatch(/Nothing is owed/);
    expect(checkPayoutAmount("1", -2).error).toMatch(/Nothing is owed/);
  });
  it("refuses a payment over the single-payment cap", () => {
    expect(checkPayoutAmount("1000000.01", 5_000_000).error).toMatch(/1,000,000/);
    expect(checkPayoutAmount("1000000", 5_000_000).error).toBeNull();
  });
});

describe("todayISO and payoutDate", () => {
  it("formats a local date as YYYY-MM-DD", () => {
    expect(todayISO(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(todayISO(new Date(2026, 10, 30, 0, 1))).toBe("2026-11-30");
  });
  it("shows a payment date on the same calendar day in any timezone, and nothing for bad input", () => {
    expect(payoutDate("2026-01-05")).toBe(new Date(2026, 0, 5).toLocaleDateString());
    expect(payoutDate("2026-01-05T00:00:00Z")).toBe(new Date(2026, 0, 5).toLocaleDateString());
    expect(payoutDate("nonsense")).toBe("");
    expect(payoutDate(null)).toBe("");
  });
});

describe("commissionExplainer", () => {
  it("explains both kinds", () => {
    expect(commissionExplainer("fixed")).toMatch(/once/);
    expect(commissionExplainer("percent")).toMatch(/profit/);
  });
});
