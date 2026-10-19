import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_PREFIX, NUMBER_PREFIX, defaultHours, describeHours, hoursErrors, hoursFromRow, hoursToPayload, newBreak,
  sameHours, scheduleFromShared, validateHours, type Break, type CallingHours, type DaySchedule,
} from "./callingHours";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ZONES = ["UTC", "Asia/Karachi"];
const brk = (start: string, end: string): Break => ({ start, end });

/** Hours on, Mon-Fri 9-6, the same every day, with `breaks`. */
const same = (breaks: Break[] = [], over: Partial<CallingHours> = {}): CallingHours => ({
  enabled: true, timezone: "UTC", days: [0, 1, 2, 3, 4], start: "09:00", end: "18:00", mode: "same", breaks, ...over,
});
/** Hours on with a custom schedule: {weekday: [start, end, breaks]}, every other day off. */
const perDay = (days: Record<number, [string, string, Break[]?]>, over: Partial<CallingHours> = {}): CallingHours => ({
  enabled: true, timezone: "UTC", days: Object.keys(days).map(Number), start: "09:00", end: "18:00", mode: "per_day", breaks: [],
  scheduleEdited: true,
  schedule: Array.from({ length: 7 }, (_, d): DaySchedule => days[d]
    ? { on: true, start: days[d][0], end: days[d][1], breaks: days[d][2] ?? [] }
    : { on: false, start: "09:00", end: "18:00", breaks: [] }),
  ...over,
});

describe("hoursErrors: the same schedule every day", () => {
  it("has no problem with good hours, with or without breaks", () => {
    expect(hoursErrors(same(), ZONES)).toEqual({});
    expect(hoursErrors(same([brk("13:00", "14:00")]), ZONES)).toEqual({});
    expect(validateHours(same([brk("12:00", "12:30"), brk("15:00", "15:15")]), ZONES)).toBeNull();
  });

  it("an end that is not after the start is reported on the times", () => {
    expect(hoursErrors(same([], { start: "18:00", end: "09:00" }), ZONES)).toEqual({ time: "End time must be after start time." });
    expect(hoursErrors(same([], { start: "09:00", end: "09:00" }), ZONES).time).toBe("End time must be after start time.");
  });

  it("a break must end after it starts, on that break", () => {
    expect(hoursErrors(same([brk("14:00", "13:00")]), ZONES)).toEqual({ "break:0": "A break must end after it starts." });
    expect(hoursErrors(same([brk("13:00", "13:00")]), ZONES)["break:0"]).toBe("A break must end after it starts.");
  });

  it("a break must lie inside the running hours, and the message says what they are", () => {
    const outside = "A break must fall inside the running hours (9:00 AM–6:00 PM).";
    for (const b of [brk("08:00", "10:00"), brk("17:00", "19:00"), brk("18:00", "19:00"), brk("07:00", "08:00")]) {
      expect(hoursErrors(same([b]), ZONES)["break:0"], JSON.stringify(b)).toBe(outside);
    }
    // touching the edges is fine
    expect(hoursErrors(same([brk("09:00", "10:00")]), ZONES)).toEqual({});
    expect(hoursErrors(same([brk("17:00", "18:00")]), ZONES)).toEqual({});
  });

  it("overlapping breaks: the later one is told, whichever order they were entered in", () => {
    expect(hoursErrors(same([brk("12:00", "14:00"), brk("13:00", "15:00")]), ZONES)).toEqual({ "break:1": "Breaks can't overlap." });
    expect(hoursErrors(same([brk("13:00", "15:00"), brk("12:00", "14:00")]), ZONES)).toEqual({ "break:0": "Breaks can't overlap." });
    expect(hoursErrors(same([brk("12:00", "15:00"), brk("13:00", "14:00")]), ZONES)).toEqual({ "break:1": "Breaks can't overlap." });
    expect(hoursErrors(same([brk("12:00", "13:00"), brk("12:00", "13:00")]), ZONES)).toEqual({ "break:1": "Breaks can't overlap." });
  });

  it("breaks that touch are fine", () => {
    expect(hoursErrors(same([brk("12:00", "13:00"), brk("13:00", "14:00")]), ZONES)).toEqual({});
  });

  it("breaks cannot cover the whole running time", () => {
    expect(hoursErrors(same([brk("09:00", "18:00")]), ZONES)).toEqual({ breaks: "The breaks leave no time to run." });
    expect(hoursErrors(same([brk("09:00", "12:00"), brk("12:00", "18:00")]), ZONES).breaks).toBe("The breaks leave no time to run.");
  });

  it("an end of midnight counts as the end of the day for the window and for a break", () => {
    expect(hoursErrors(same([brk("22:00", "00:00")], { start: "08:00", end: "00:00" }), ZONES)).toEqual({});
    expect(hoursErrors(same([brk("22:00", "00:00")]), ZONES)["break:0"]).toMatch(/inside the running hours/);
  });

  it("at most ten breaks", () => {
    const ten = [...Array.from({ length: 9 }, (_, i) => brk(`${String(9 + i).padStart(2, "0")}:00`, `${String(9 + i).padStart(2, "0")}:10`)), brk("17:30", "17:40")];
    expect(hoursErrors(same(ten), ZONES)).toEqual({});
    expect(hoursErrors(same([...ten, brk("17:45", "17:50")]), ZONES).breaks).toBe("Add at most 10 breaks.");
  });

  it("breaks are not checked against a window that is itself wrong (only the window is reported)", () => {
    expect(hoursErrors(same([brk("13:00", "14:00")], { start: "18:00", end: "09:00" }), ZONES)).toEqual({ time: "End time must be after start time." });
  });

  it("keeps the old messages and their order: time zone, then days, then times", () => {
    expect(validateHours(same([], { timezone: "", days: [], start: "18:00", end: "09:00" }), ZONES)).toBe("Select a time zone.");
    expect(validateHours(same([], { days: [], start: "18:00", end: "09:00" }), ZONES)).toBe("Pick at least one day.");
    expect(validateHours(same([], { start: "xx", end: "09:00" }), ZONES)).toBe("Enter the start and end times.");
    expect(validateHours(same([], { start: "18:00", end: "09:00" }), ZONES)).toBe("End time must be after start time.");
  });

  it("with the hours off the zone is not required but breaks are still checked, like the server", () => {
    expect(hoursErrors(same([], { enabled: false, timezone: "" }), ZONES)).toEqual({});
    expect(hoursErrors(same([brk("07:00", "08:00")], { enabled: false, timezone: "" }), ZONES)["break:0"]).toMatch(/inside/);
  });
});

describe("hoursErrors: a custom schedule per day", () => {
  it("good hours with breaks on some days", () => {
    expect(hoursErrors(perDay({ 0: ["09:00", "18:00", [brk("13:00", "14:00")]], 5: ["10:00", "14:00"] }), ZONES)).toEqual({});
  });

  it("each problem is keyed by its day, and the message names the day", () => {
    const h = perDay({ 0: ["09:00", "18:00"], 2: ["10:00", "09:00"], 4: ["09:00", "12:00", [brk("12:00", "13:00"), brk("11:00", "11:30")]] });
    expect(hoursErrors(h, ZONES)).toEqual({
      "day:2:time": "End time must be after start time.",
      "day:4:break:0": "A break must fall inside the running hours (9:00 AM–12:00 PM).",
    });
    expect(validateHours(h, ZONES)).toBe("Wednesday: End time must be after start time.");
  });

  it("a day that is off is never validated, whatever times it still holds", () => {
    const h = perDay({ 0: ["09:00", "18:00"] });
    h.schedule![3] = { on: false, start: "18:00", end: "09:00", breaks: [brk("01:00", "02:00")] };
    expect(hoursErrors(h, ZONES)).toEqual({});
  });

  it("at least one day must be on", () => {
    const h = perDay({ 0: ["09:00", "18:00"] });
    h.schedule![0] = { ...h.schedule![0], on: false };
    expect(hoursErrors(h, ZONES)).toEqual({ schedule: "Pick at least one day." });
    expect(validateHours(h, ZONES)).toBe("Pick at least one day.");
  });

  it("the shared fields are not checked while a custom schedule is chosen", () => {
    expect(hoursErrors(perDay({ 0: ["09:00", "18:00"] }, { days: [], start: "18:00", end: "09:00", breaks: [brk("01:00", "02:00")] }), ZONES)).toEqual({});
  });

  it("still needs a time zone once on", () => {
    expect(validateHours(perDay({ 0: ["09:00", "18:00"] }, { timezone: "" }), ZONES)).toBe("Select a time zone.");
  });
});

describe("reading and sending a campaign's schedule", () => {
  const row = (schedule: unknown, over: Record<string, unknown> = {}) => ({
    call_hours_enabled: true, call_hours_timezone: "Asia/Karachi", call_hours_days: [0, 1, 2, 3, 4],
    call_hours_start: "09:00", call_hours_end: "18:00", call_hours_schedule: schedule, ...over,
  });

  it("a row without a schedule is the same every day with no breaks", () => {
    for (const none of [undefined, null, {}, [], "x"]) {
      const h = hoursFromRow(row(none), CAMPAIGN_PREFIX);
      expect(h.mode, String(none)).toBe("same");
      expect(h.breaks).toEqual([]);
      expect(h.scheduleEdited).toBe(false);
    }
  });

  it("reads the breaks of the shared schedule", () => {
    const h = hoursFromRow(row({ mode: "same", breaks: [brk("13:00", "14:00")] }), CAMPAIGN_PREFIX);
    expect(h.mode).toBe("same");
    expect(h.breaks).toEqual([brk("13:00", "14:00")]);
  });

  it("drops breaks that are not a start/end pair", () => {
    const h = hoursFromRow(row({ mode: "same", breaks: [brk("13:00", "14:00"), "lunch", { start: 5 }, null] }), CAMPAIGN_PREFIX);
    expect(h.breaks).toEqual([brk("13:00", "14:00")]);
  });

  it("reads a custom schedule: the days that are on keep their times and breaks, the others are off", () => {
    const h = hoursFromRow(row({
      mode: "per_day",
      days: { "0": { on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] }, "5": { on: true, start: "10:00", end: "14:00", breaks: [] }, "1": { on: false } },
    }), CAMPAIGN_PREFIX);
    expect(h.mode).toBe("per_day");
    expect(h.scheduleEdited).toBe(true);
    expect(h.schedule!.map((d) => d.on)).toEqual([true, false, false, false, false, true, false]);
    expect(h.schedule![0]).toEqual({ on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] });
    expect(h.schedule![5]).toEqual({ on: true, start: "10:00", end: "14:00", breaks: [] });
    expect(h.schedule![1]).toMatchObject({ on: false, breaks: [] });
  });

  it("a custom schedule with nothing usable falls back to all days off with the shared times", () => {
    const h = hoursFromRow(row({ mode: "per_day", days: { "0": { on: true, start: "late", end: null } } }), CAMPAIGN_PREFIX);
    expect(h.schedule![0]).toMatchObject({ on: true, start: "09:00", end: "18:00" });
  });

  it("a per-day mode without any days is read as the shared schedule", () => {
    expect(hoursFromRow(row({ mode: "per_day" }), CAMPAIGN_PREFIX).mode).toBe("same");
  });

  it("until a custom schedule exists, it is the shared one: the same days on, the same hours and breaks", () => {
    const h = hoursFromRow(row({ mode: "same", breaks: [brk("13:00", "14:00")] }), CAMPAIGN_PREFIX);
    expect(h.schedule!.map((d) => d.on)).toEqual([true, true, true, true, true, false, false]);
    expect(h.schedule![2]).toEqual({ on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] });
  });

  it("sends the shared schedule with its breaks", () => {
    expect(hoursToPayload(same([brk("13:00", "14:00")]), CAMPAIGN_PREFIX)).toMatchObject({
      call_hours_enabled: true, call_hours_start: "09:00", call_hours_end: "18:00",
      call_hours_schedule: { mode: "same", breaks: [brk("13:00", "14:00")] },
    });
    expect(hoursToPayload(same(), CAMPAIGN_PREFIX).call_hours_schedule).toEqual({ mode: "same", breaks: [] });
    expect(hoursToPayload(defaultHours(), CAMPAIGN_PREFIX).call_hours_schedule).toEqual({ mode: "same", breaks: [] });
  });

  it("sends only the active mode: a custom schedule carries its days, nothing of the shared breaks", () => {
    const sent = hoursToPayload(perDay({ 0: ["09:00", "18:00", [brk("13:00", "14:00")]], 5: ["10:00", "14:00"] }, { breaks: [brk("01:00", "02:00")] }), CAMPAIGN_PREFIX);
    expect(sent.call_hours_schedule).toEqual({
      mode: "per_day",
      days: {
        "0": { on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] },
        "1": { on: false }, "2": { on: false }, "3": { on: false }, "4": { on: false },
        "5": { on: true, start: "10:00", end: "14:00", breaks: [] },
        "6": { on: false },
      },
    });
  });

  it("a custom schedule that was never edited is sent as the shared one expanded", () => {
    const h = same([brk("13:00", "14:00")], { mode: "per_day" });
    const days = (hoursToPayload(h, CAMPAIGN_PREFIX).call_hours_schedule as { days: Record<string, DaySchedule> }).days;
    expect(days["2"]).toEqual({ on: true, start: "09:00", end: "18:00", breaks: [brk("13:00", "14:00")] });
    expect(days["6"]).toEqual({ on: false });
  });

  it("phone numbers never get a schedule", () => {
    expect(hoursToPayload(same([brk("13:00", "14:00")]), NUMBER_PREFIX)).not.toHaveProperty("answer_hours_schedule");
    expect(Object.keys(hoursToPayload(same(), NUMBER_PREFIX)).sort()).toEqual(
      ["answer_hours_days", "answer_hours_enabled", "answer_hours_end", "answer_hours_start", "answer_hours_timezone"]);
  });

  it("round-trips, for both modes", () => {
    const a = same([brk("12:00", "12:30"), brk("15:00", "15:15")], { timezone: "Asia/Karachi" });
    const b = perDay({ 1: ["08:15", "00:00", [brk("12:00", "13:00")]], 6: ["10:00", "12:00"] }, { timezone: "Asia/Karachi" });
    for (const h of [a, b]) {
      const back = hoursFromRow(hoursToPayload(h, CAMPAIGN_PREFIX), CAMPAIGN_PREFIX);
      expect(back.mode).toBe(h.mode);
      if (h.mode === "same") expect(back.breaks).toEqual(h.breaks);
      else expect(back.schedule).toEqual(h.schedule!.map((d) => (d.on ? d : { ...d, start: back.start, end: back.end, breaks: [] })));
    }
  });
});

describe("describeHours with breaks and custom days", () => {
  it("is unchanged without breaks", () => {
    expect(describeHours(same(), DAYS)).toBe("Mon–Fri, 9:00 AM–6:00 PM (UTC)");
  });

  it("says the same words as the server does", () => {
    expect(describeHours(same([brk("13:00", "14:00")], { timezone: "Asia/Karachi" }), DAYS))
      .toBe("Mon–Fri, 9:00 AM–6:00 PM, break 1:00 PM–2:00 PM (Asia/Karachi)");
    expect(describeHours(same([brk("12:00", "12:30"), brk("15:00", "15:15")]), DAYS))
      .toBe("Mon–Fri, 9:00 AM–6:00 PM, break 12:00 PM–12:30 PM and 3:00 PM–3:15 PM (UTC)");
    const lunch = [brk("13:00", "14:00")];
    expect(describeHours(perDay({ 0: ["09:00", "18:00", lunch], 1: ["09:00", "18:00", lunch], 2: ["09:00", "18:00", lunch], 5: ["10:00", "14:00"] }, { timezone: "Asia/Karachi" }), DAYS))
      .toBe("Mon–Wed 9:00 AM–6:00 PM (break 1:00 PM–2:00 PM); Sat 10:00 AM–2:00 PM (Asia/Karachi)");
  });

  it("a day with a different break is its own group", () => {
    expect(describeHours(perDay({ 0: ["09:00", "18:00", [brk("13:00", "14:00")]], 1: ["09:00", "18:00", [brk("12:00", "13:00")]] }), DAYS))
      .toBe("Mon 9:00 AM–6:00 PM (break 1:00 PM–2:00 PM); Tue 9:00 AM–6:00 PM (break 12:00 PM–1:00 PM) (UTC)");
  });
});

describe("newBreak", () => {
  it("starts with lunchtime when the window has it", () => {
    expect(newBreak("09:00", "18:00", [])).toEqual(brk("13:00", "14:00"));
  });

  it("goes to the next free common gap when lunchtime is taken", () => {
    expect(newBreak("09:00", "18:00", [brk("13:00", "14:00")])).toEqual(brk("12:00", "12:30"));
    expect(newBreak("09:00", "18:00", [brk("13:00", "14:00"), brk("12:00", "12:30")])).toEqual(brk("15:00", "15:30"));
  });

  it("always fits inside a short window, clear of the others", () => {
    expect(newBreak("09:00", "11:00", [])).toEqual(brk("10:30", "10:45"));
    expect(newBreak("09:00", "09:45", [])).toEqual(brk("09:00", "09:15"));
    expect(newBreak("09:00", "09:45", [brk("09:00", "09:15")])).toEqual(brk("09:15", "09:30"));
  });

  it("a break up to the end of the day is written 00:00", () => {
    expect(newBreak("23:00", "00:00", [])).toEqual(brk("23:00", "23:15"));
    expect(newBreak("20:00", "00:00", [brk("20:00", "23:45")])).toEqual(brk("23:45", "00:00"));
  });

  it("falls back to lunchtime when nothing is free (the form then shows the problem)", () => {
    expect(newBreak("09:00", "09:15", [brk("09:00", "09:15")])).toEqual(brk("13:00", "14:00"));
  });
});

describe("sameHours with schedules", () => {
  it("notices a changed break, mode or custom day", () => {
    expect(sameHours(same(), same())).toBe(true);
    expect(sameHours(same(), same([brk("13:00", "14:00")]))).toBe(false);
    expect(sameHours(same([brk("13:00", "14:00")]), same([brk("13:00", "14:00")]))).toBe(true);
    expect(sameHours(same(), same([], { mode: "per_day" }))).toBe(false);
    expect(sameHours(perDay({ 0: ["09:00", "18:00"] }), perDay({ 0: ["09:00", "17:00"] }))).toBe(false);
    expect(sameHours(perDay({ 0: ["09:00", "18:00"] }), perDay({ 0: ["09:00", "18:00"] }))).toBe(true);
  });

  it("hours without the new fields (a phone number's) compare as before", () => {
    const a: CallingHours = { enabled: true, timezone: "UTC", days: [0, 1], start: "09:00", end: "17:00" };
    expect(sameHours(a, { ...a, days: [1, 0] })).toBe(true);
    expect(sameHours(a, { ...a, end: "18:00" })).toBe(false);
  });
});

describe("scheduleFromShared", () => {
  it("copies the window and breaks to the days that are on, and does not share the break objects", () => {
    const shared = { days: [0, 2], start: "08:00", end: "12:00", breaks: [brk("10:00", "10:15")] };
    const s = scheduleFromShared(shared);
    expect(s.map((d) => d.on)).toEqual([true, false, true, false, false, false, false]);
    expect(s[0]).toEqual({ on: true, start: "08:00", end: "12:00", breaks: [brk("10:00", "10:15")] });
    s[0].breaks[0].start = "11:00";
    expect(shared.breaks[0].start).toBe("10:00");
    expect(s[2].breaks[0].start).toBe("10:00");
  });
});
