import { describe, expect, it, vi } from "vitest";
import {
  CAMPAIGN_PREFIX, NUMBER_PREFIX, daysText, defaultHours, describeHours, describeNextOpen, hoursFromRow,
  hoursToPayload, sameHours, validateHours, type CallingHours,
} from "./callingHours";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hours = (over: Partial<CallingHours> = {}): CallingHours => ({
  enabled: true, timezone: "UTC", days: [0, 1, 2, 3, 4], start: "09:00", end: "17:00", ...over,
});

describe("defaultHours", () => {
  it("is switched off, Monday to Friday, 9 to 5, with NO time zone chosen", () => {
    expect(defaultHours()).toEqual({ enabled: false, timezone: "", days: [0, 1, 2, 3, 4], start: "09:00", end: "17:00" });
  });

  it("does not take the time zone from the browser", () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "Asia/Karachi" } as Intl.ResolvedDateTimeFormatOptions);
    try {
      expect(defaultHours().timezone).toBe("");
      expect(hoursFromRow(undefined, CAMPAIGN_PREFIX).timezone).toBe("");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("hoursFromRow / hoursToPayload", () => {
  it("reads a campaign row and a phone-number row by their own prefix", () => {
    const campaign = { call_hours_enabled: true, call_hours_timezone: "Asia/Karachi", call_hours_days: [1, 2], call_hours_start: "10:00", call_hours_end: "12:00", answer_hours_enabled: false };
    expect(hoursFromRow(campaign, CAMPAIGN_PREFIX)).toEqual({ enabled: true, timezone: "Asia/Karachi", days: [1, 2], start: "10:00", end: "12:00" });
    expect(hoursFromRow(campaign, NUMBER_PREFIX).enabled).toBe(false);
  });

  it("falls back to the defaults for a row without hours, and never treats a truthy non-boolean as on", () => {
    expect(hoursFromRow(undefined, CAMPAIGN_PREFIX)).toMatchObject({ enabled: false, days: [0, 1, 2, 3, 4], start: "09:00", end: "17:00" });
    expect(hoursFromRow({ call_hours_enabled: "yes" }, CAMPAIGN_PREFIX).enabled).toBe(false);
    expect(hoursFromRow({ call_hours_days: [], call_hours_timezone: "" }, CAMPAIGN_PREFIX).days).toEqual([0, 1, 2, 3, 4]);
  });

  it("a row whose hours are off and still hold the server's untouched UTC shows no time zone", () => {
    const untouched = { call_hours_enabled: false, call_hours_timezone: "UTC", call_hours_days: [0, 1, 2, 3, 4], call_hours_start: "09:00", call_hours_end: "17:00" };
    expect(hoursFromRow(untouched, CAMPAIGN_PREFIX).timezone).toBe("");
  });

  it("a time zone someone saved is kept, off or on, and UTC chosen on purpose stays while the hours are on", () => {
    expect(hoursFromRow({ call_hours_enabled: false, call_hours_timezone: "Asia/Karachi" }, CAMPAIGN_PREFIX).timezone).toBe("Asia/Karachi");
    expect(hoursFromRow({ call_hours_enabled: true, call_hours_timezone: "Asia/Karachi" }, CAMPAIGN_PREFIX).timezone).toBe("Asia/Karachi");
    expect(hoursFromRow({ answer_hours_enabled: true, answer_hours_timezone: "UTC" }, NUMBER_PREFIX).timezone).toBe("UTC");
  });

  it("leaves the time zone out of what it sends while none is chosen", () => {
    const payload = hoursToPayload(hours({ enabled: false, timezone: "" }), CAMPAIGN_PREFIX);
    expect(payload).not.toHaveProperty("call_hours_timezone");
    expect(payload).toMatchObject({ call_hours_enabled: false, call_hours_start: "09:00" });
  });

  it("sends all five fields under the prefix, days sorted", () => {
    expect(hoursToPayload(hours({ days: [4, 0, 2] }), NUMBER_PREFIX)).toEqual({
      answer_hours_enabled: true, answer_hours_timezone: "UTC", answer_hours_days: [0, 2, 4],
      answer_hours_start: "09:00", answer_hours_end: "17:00",
    });
  });

  it("round-trips", () => {
    const h = hours({ timezone: "Europe/London", days: [5, 6], start: "08:15", end: "00:00" });
    expect(hoursFromRow(hoursToPayload(h, CAMPAIGN_PREFIX), CAMPAIGN_PREFIX)).toEqual(h);
  });
});

describe("validateHours", () => {
  const zones = ["UTC", "Europe/London"];
  it("accepts good hours, including an end of midnight", () => {
    expect(validateHours(hours(), zones)).toBeNull();
    expect(validateHours(hours({ start: "00:00", end: "00:00" }), zones)).toBeNull();
    expect(validateHours(hours({ timezone: "Europe/London", end: "23:45" }), zones)).toBeNull();
  });

  it("switched on, a time zone must be chosen", () => {
    expect(validateHours(hours({ timezone: "" }), zones)).toBe("Select a time zone.");
    expect(validateHours(hours({ timezone: "   " }), zones)).toBe("Select a time zone.");
  });

  it("switched off, an unchosen time zone is fine (nothing is limited), but days and times are still checked", () => {
    expect(validateHours(hours({ enabled: false, timezone: "" }), zones)).toBeNull();
    expect(validateHours(hours({ enabled: false, timezone: "", days: [] }), zones)).toMatch(/at least one day/);
    expect(validateHours(hours({ enabled: false, timezone: "", start: "17:00", end: "09:00" }), zones)).toMatch(/after start/);
  });

  it("explains each problem", () => {
    expect(validateHours(hours({ timezone: "Mars/Base" }), zones)).toMatch(/time zone/);
    expect(validateHours(hours({ days: [] }), zones)).toMatch(/at least one day/);
    expect(validateHours(hours({ start: "", end: "17:00" }), zones)).toMatch(/start and end/);
    expect(validateHours(hours({ start: "17:00", end: "09:00" }), zones)).toMatch(/after start/);
    expect(validateHours(hours({ start: "09:00", end: "09:00" }), zones)).toMatch(/after start/);
  });
});

describe("describing hours", () => {
  it("compresses runs of days", () => {
    expect(daysText([0, 1, 2, 3, 4], DAYS)).toBe("Mon–Fri");
    expect(daysText([0, 1, 2, 3, 4, 5, 6], DAYS)).toBe("Every day");
    expect(daysText([5, 6], DAYS)).toBe("Sat, Sun");
    expect(daysText([0, 1, 2, 5], DAYS)).toBe("Mon–Wed, Sat");
    expect(daysText([4, 0, 2], DAYS)).toBe("Mon, Wed, Fri");
    expect(daysText([3], DAYS)).toBe("Thu");
  });

  it("writes the whole window with 12-hour times", () => {
    expect(describeHours(hours({ timezone: "America/New_York" }), DAYS)).toBe("Mon–Fri, 9:00 AM–5:00 PM (America/New_York)");
    expect(describeHours(hours({ start: "00:00", end: "12:30" }), DAYS)).toContain("12:00 AM–12:30 PM");
  });

  it("says midnight and all day in words, like the server does", () => {
    expect(describeHours(hours({ start: "08:00", end: "00:00" }), DAYS)).toContain(", 8:00 AM–midnight (");
    expect(describeHours(hours({ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" }), DAYS)).toBe("Every day, all day (UTC)");
    expect(describeHours(hours({ start: "00:00", end: "17:00" }), DAYS)).toContain(", 12:00 AM–5:00 PM (");
  });

  it("names the next opening in the row's own timezone, or nothing when open", () => {
    const closed = { enabled: true, open: false, next_open_at: "2026-10-13T13:00:00Z", summary: "x" };
    expect(describeNextOpen(closed, "America/New_York")).toMatch(/Tue, Oct 13, 9:00 AM/);
    expect(describeNextOpen({ ...closed, open: true, next_open_at: null }, "UTC")).toBeNull();
    expect(describeNextOpen(undefined, "UTC")).toBeNull();
  });
});

describe("sameHours", () => {
  it("ignores the order of the days only", () => {
    expect(sameHours(hours({ days: [0, 1] }), hours({ days: [1, 0] }))).toBe(true);
    expect(sameHours(hours(), hours({ enabled: false }))).toBe(false);
    expect(sameHours(hours(), hours({ start: "09:15" }))).toBe(false);
    expect(sameHours(hours(), hours({ timezone: "Europe/London" }))).toBe(false);
    expect(sameHours(hours(), hours({ days: [0, 1, 2, 3] }))).toBe(false);
  });
});
