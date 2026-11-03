import { describe, expect, it } from "vitest";
import { activityText, commissionExplainer, parseCommission, referralUrl, timeAgo } from "./partners";

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

describe("commissionExplainer", () => {
  it("explains both kinds", () => {
    expect(commissionExplainer("fixed")).toMatch(/once/);
    expect(commissionExplainer("percent")).toMatch(/profit/);
  });
});
