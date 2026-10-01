import { describe, expect, it } from "vitest";
import { hoursSummary, validateCalendarSettings, type CalendarSettings } from "./calendarTypes";

const base: CalendarSettings = {
  timezone: "Asia/Karachi", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "17:00",
  slot_minutes: 30, buffer_minutes: 0, min_notice_hours: 2, max_days_ahead: 30,
};
const zones = ["Asia/Karachi", "UTC", "America/New_York"];
const check = (over: Partial<CalendarSettings>) => validateCalendarSettings({ ...base, ...over }, zones);

describe("hoursSummary", () => {
  it("says Mon–Fri for the default week", () => {
    expect(hoursSummary(base)).toBe("Mon–Fri, 09:00–17:00 (Asia/Karachi)");
  });
  it("says Every day for all seven", () => {
    expect(hoursSummary({ ...base, work_days: [0, 1, 2, 3, 4, 5, 6] })).toMatch(/^Every day/);
  });
  it("lists custom days by name", () => {
    expect(hoursSummary({ ...base, work_days: [1, 3, 5] })).toMatch(/^Tue, Thu, Sat,/);
  });
});

describe("validateCalendarSettings", () => {
  it("accepts good settings and the exact limits", () => {
    expect(check({})).toBeNull();
    expect(check({ slot_minutes: 10, buffer_minutes: 0, min_notice_hours: 0, max_days_ahead: 1 })).toBeNull();
    expect(check({ slot_minutes: 240, buffer_minutes: 120, min_notice_hours: 168, max_days_ahead: 90 })).toBeNull();
  });
  it("rejects a timezone that isn't in the list, or is blank", () => {
    expect(check({ timezone: "Mars/Olympus" })).toMatch(/timezone/i);
    expect(check({ timezone: "   " })).toMatch(/timezone/i);
  });
  it("needs at least one working day", () => {
    expect(check({ work_days: [] })).toMatch(/working day/);
  });
  it("needs valid times with the end after the start", () => {
    expect(check({ start_time: "" })).toMatch(/start and end/);
    expect(check({ end_time: "25:00" })).toMatch(/start and end/);
    expect(check({ start_time: "17:00", end_time: "09:00" })).toMatch(/after start/);
    expect(check({ start_time: "09:00", end_time: "09:00" })).toMatch(/after start/);
  });
  it("rejects out-of-range, fractional and empty numbers, naming the field", () => {
    expect(check({ slot_minutes: 9 })).toMatch(/Meeting length.*10 to 240/);
    expect(check({ slot_minutes: 241 })).toMatch(/Meeting length/);
    expect(check({ buffer_minutes: -1 })).toMatch(/Buffer/);
    expect(check({ min_notice_hours: 169 })).toMatch(/Minimum notice/);
    expect(check({ max_days_ahead: 0 })).toMatch(/Booking window/);
    expect(check({ slot_minutes: 30.5 })).toMatch(/whole number/);
    expect(check({ slot_minutes: NaN })).toMatch(/Meeting length/);
  });
});
