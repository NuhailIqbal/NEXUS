import { describe, expect, it } from "vitest";
import {
  formatDue, isOverdue, toLocalInput, validateCallbackSettings,
  type Callback, type CallbackSettings,
} from "./callbackTypes";

const base: CallbackSettings = {
  auto_call: false, timezone: "Asia/Karachi", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "18:00",
  default_time: "10:00", retry_minutes: 30, max_attempts: 2,
};
const zones = ["Asia/Karachi", "America/New_York"];
const check = (over: Partial<CallbackSettings>) => validateCallbackSettings({ ...base, ...over }, zones);
const cb = (over: Partial<Callback> = {}): Callback => ({
  id: "1", agent_id: "a", agent_name: "Sara", contact_name: null, phone: "+1555", due_at: "2026-10-06T12:00:00Z",
  timezone: "Asia/Karachi", time_source: "caller", requested_text: null, status: "pending", attempts: 0,
  last_error: null, placed_call_id: null, created_at: "2026-10-05T00:00:00Z", ...over,
});

describe("formatDue", () => {
  it("shows the moment in the callback's own timezone", () => {
    expect(formatDue("2026-10-06T12:00:00Z", "Asia/Karachi")).toMatch(/Tue, Oct 6, 5:00 PM/);
    expect(formatDue("2026-10-06T12:00:00Z", "America/New_York")).toMatch(/8:00 AM/);
  });
  it("survives a bad date or timezone", () => {
    expect(formatDue("not a date", "UTC")).toBe("—");
    expect(formatDue("2026-10-06T12:00:00Z", "Mars/Olympus")).toMatch(/Oct 6/);
  });
});

describe("toLocalInput", () => {
  it("gives the wall-clock value a datetime-local box expects, in that timezone", () => {
    expect(toLocalInput("2026-10-06T12:00:00Z", "Asia/Karachi")).toBe("2026-10-06T17:00");
    expect(toLocalInput("2026-10-06T12:00:00Z", "America/New_York")).toBe("2026-10-06T08:00");
  });
  it("midnight is 00:xx, never 24:xx", () => {
    expect(toLocalInput("2026-10-05T19:05:00Z", "Asia/Karachi")).toBe("2026-10-06T00:05");
  });
  it("bad input gives an empty box", () => {
    expect(toLocalInput("nope", "UTC")).toBe("");
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-10-06T13:00:00Z");
  it("only a waiting callback in the past is overdue", () => {
    expect(isOverdue(cb(), now)).toBe(true);
    expect(isOverdue(cb({ due_at: "2026-10-06T14:00:00Z" }), now)).toBe(false);
    for (const status of ["called", "failed", "cancelled", "skipped", "calling"] as const) {
      expect(isOverdue(cb({ status }), now), status).toBe(false);
    }
  });
});

describe("validateCallbackSettings", () => {
  it("accepts good settings and the exact limits", () => {
    expect(check({})).toBeNull();
    expect(check({ retry_minutes: 5, max_attempts: 1 })).toBeNull();
    expect(check({ retry_minutes: 1440, max_attempts: 5 })).toBeNull();
    expect(check({ default_time: "09:00" })).toBeNull();
    expect(check({ timezone: "UTC" })).toBeNull();                               // always allowed
  });
  it("treats a 12:00 AM closing time as the end of the day", () => {
    expect(check({ start_time: "21:00", end_time: "00:00", default_time: "22:00" })).toBeNull();
    expect(check({ start_time: "21:00", end_time: "00:00", default_time: "08:00" })).toMatch(/inside your calling hours/);
    expect(check({ start_time: "00:00", end_time: "00:00", default_time: "00:00" })).toMatch(/after start/);
  });
  it("rejects what the server rejects", () => {
    expect(check({ timezone: "Mars/Olympus" })).toMatch(/timezone/i);
    expect(check({ work_days: [] })).toMatch(/calling day/);
    expect(check({ start_time: "" })).toMatch(/times/);
    expect(check({ start_time: "18:00", end_time: "09:00", default_time: "10:00" })).toMatch(/after start/);
    expect(check({ default_time: "08:00" })).toMatch(/inside your calling hours/);
    expect(check({ default_time: "18:00" })).toMatch(/inside your calling hours/);
    expect(check({ retry_minutes: 4 })).toMatch(/Retry/);
    expect(check({ retry_minutes: NaN })).toMatch(/Retry/);
    expect(check({ max_attempts: 6 })).toMatch(/Attempts/);
    expect(check({ max_attempts: 1.5 })).toMatch(/Attempts/);
  });
});
