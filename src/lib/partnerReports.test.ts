import { describe, expect, it } from "vitest";
import {
  browserTimeZone, buildReportQuery, customRangeError, customRangeReady, periodLabel, periodSpan, reportDay, reportFilename,
} from "./partnerReports";

const custom = { group: "day" as const, start: "", end: "" };

describe("buildReportQuery", () => {
  it("turns a preset into just its grouping (the server picks the usual range) plus the time zone", () => {
    expect(buildReportQuery("week", custom, "all", "Asia/Karachi", "2026-11-06")).toEqual({ group: "week", tz: "Asia/Karachi" });
    expect(buildReportQuery("year", custom, "all", "UTC", "2026-11-06")).toEqual({ group: "year", tz: "UTC" });
  });
  it("adds the partner only when one is chosen", () => {
    expect(buildReportQuery("month", custom, "abc", "UTC", "2026-11-06")).toEqual({ group: "month", tz: "UTC", partner_id: "abc" });
    expect(buildReportQuery("month", custom, "", "UTC", "2026-11-06")).toEqual({ group: "month", tz: "UTC" });
  });
  it("sends a custom range with its own grouping, and nothing until the range is usable", () => {
    const c = { group: "week" as const, start: "2026-10-01", end: "2026-10-31" };
    expect(buildReportQuery("custom", c, "all", "UTC", "2026-11-06")).toEqual({ group: "week", start: "2026-10-01", end: "2026-10-31", tz: "UTC" });
    expect(buildReportQuery("custom", custom, "all", "UTC", "2026-11-06")).toBeNull();
    expect(buildReportQuery("custom", { ...c, start: "2026-11-02", end: "2026-10-01" }, "all", "UTC", "2026-11-06")).toBeNull();
  });
});

describe("customRangeError", () => {
  const today = "2026-11-06";
  it("accepts a normal range, today as the last day, and a single day", () => {
    expect(customRangeError("2026-10-01", "2026-11-06", today)).toBeNull();
    expect(customRangeError("2026-11-06", "2026-11-06", today)).toBeNull();
  });
  it("says nothing while a date is still empty, and explains each refusal", () => {
    expect(customRangeError("", "2026-11-01", today)).toBeNull();
    expect(customRangeError("2026-11-01", "", today)).toBeNull();
    expect(customRangeError("2026-11-05", "2026-11-01", today)).toMatch(/on or before/);
    expect(customRangeError("2026-11-07", "2026-11-09", today)).toMatch(/future/);
    expect(customRangeError("2019-12-31", "2026-11-01", today)).toMatch(/2020/);
    expect(customRangeError("2026-13-45", "2026-11-01", today)).toMatch(/Enter both dates/);
  });
  it("is ready only with two valid dates", () => {
    expect(customRangeReady("2026-10-01", "2026-10-31", today)).toBe(true);
    expect(customRangeReady("", "2026-10-31", today)).toBe(false);
    expect(customRangeReady("2026-11-02", "2026-10-31", today)).toBe(false);
  });
});

describe("period names", () => {
  it("names each grouping from the period's first day", () => {
    expect(periodLabel("day", "2026-11-06", "en-US")).toBe("Fri, Nov 6, 2026");
    expect(periodLabel("week", "2026-11-02", "en-US")).toBe("Week of Nov 2, 2026");
    expect(periodLabel("month", "2026-11-01", "en-US")).toBe("November 2026");
    expect(periodLabel("year", "2026-01-01", "en-US")).toBe("2026");
    expect(periodLabel("week", "garbage", "en-US")).toBe("");
  });
  it("shows the dates behind a week, and behind a month or year only when the range cut it short", () => {
    expect(periodSpan("week", { key: "2026-11-02", start: "2026-11-02", end: "2026-11-08" }, "en-US")).toBe("Nov 2, 2026 – Nov 8, 2026");
    expect(periodSpan("week", { key: "2026-10-05", start: "2026-10-06", end: "2026-10-11" }, "en-US")).toBe("Oct 6, 2026 – Oct 11, 2026");
    expect(periodSpan("month", { key: "2026-10-01", start: "2026-10-01", end: "2026-10-31" }, "en-US")).toBe("");
    expect(periodSpan("month", { key: "2026-11-01", start: "2026-11-01", end: "2026-11-06" }, "en-US")).toBe("Nov 1, 2026 – Nov 6, 2026");
    expect(periodSpan("year", { key: "2025-01-01", start: "2025-01-01", end: "2025-12-31" }, "en-US")).toBe("");
    expect(periodSpan("year", { key: "2026-01-01", start: "2026-01-01", end: "2026-11-06" }, "en-US")).toBe("Jan 1, 2026 – Nov 6, 2026");
    expect(periodSpan("day", { key: "2026-11-06", start: "2026-11-06", end: "2026-11-06" }, "en-US")).toBe("");
  });
  it("writes a calendar day the same in any time zone", () => {
    expect(reportDay("2026-01-05", "en-US")).toBe("Jan 5, 2026");
    expect(reportDay("nonsense", "en-US")).toBe("");
  });
});

describe("reportFilename and browserTimeZone", () => {
  it("builds a safe file name from the scope and the dates on screen", () => {
    const r = { group: "month" as const, start: "2025-12-01", end: "2026-11-06" };
    expect(reportFilename(r, "all-partners")).toBe("commission-report-all-partners-month-2025-12-01_to_2026-11-06.csv");
    expect(reportFilename(r, "Pine & Co / ../x")).toBe("commission-report-pine-co-x-month-2025-12-01_to_2026-11-06.csv");
    expect(reportFilename(r, "***")).toBe("commission-report-partner-month-2025-12-01_to_2026-11-06.csv");
    expect(reportFilename(r)).toBe("commission-report-month-2025-12-01_to_2026-11-06.csv");
  });
  it("gives a time zone name", () => {
    expect(browserTimeZone().length).toBeGreaterThan(0);
  });
});
