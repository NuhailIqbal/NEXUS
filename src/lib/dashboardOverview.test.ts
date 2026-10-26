import { describe, expect, it } from "vitest";
import {
  buildAlerts, changeLine, changeParts, chartIsEmpty, notAnsweredBreakdown, chartPoints, customPresets, hourLabel, dayCostPerQualified, dayLabel, dayRate, firstName, formatDuration, formatMinutes, funnelStages,
  greeting, previousLabel, progressPct, runningSub, setupSteps, statusLine, type Tiles,
  type CampaignItem,
} from "./dashboardOverview";

const camp = (over: Partial<CampaignItem> = {}): CampaignItem => ({
  id: "c1", name: "Spring", status: "Active", contacts_count: 10, completed_count: 4, state: "dialing", active_now: 0,
  stall_reason: null, warnings: [], errors: 0, last_error: null, waiting_for_hours: false, ...over,
});
const view = (items: CampaignItem[] = []) => ({ campaigns: { counts: { active: 0, paused: 0, inactive: 0 }, items } });

describe("changeLine", () => {
  it("signs the change and names what it is against", () => {
    expect(changeLine(12.5, "%", "7d")).toBe("+12.5% vs the 7 days before");
    expect(changeLine(-3, " pts", "today")).toBe("-3.0 pts vs yesterday");
    expect(changeLine(0, "%", "30d")).toBe("0.0% vs the 30 days before");
  });
  it("is null when there is nothing to compare", () => {
    expect(changeLine(null, "%", "7d")).toBeNull();
    expect(changeLine(undefined, "%", "7d")).toBeNull();
  });
});

describe("formatters", () => {
  it("formats minutes", () => {
    expect(formatMinutes(0)).toBe("0.0 min");
    expect(formatMinutes(3)).toBe("3.0 min");
    expect(formatMinutes(42.4)).toBe("42 min");
    expect(formatMinutes(65)).toBe("1h 05m");
    expect(formatMinutes(119.7)).toBe("2h 00m");   // never "1h 60m"
    expect(formatMinutes(null)).toBe("0.0 min");
  });
  it("formats a duration", () => {
    expect(formatDuration(45)).toBe("0:45");
    expect(formatDuration(723)).toBe("12:03");
    expect(formatDuration(null)).toBe("0:00");
  });
  it("reads a day as a calendar date, not an instant", () => {
    expect(dayLabel("2026-10-26")).toBe("Oct 26");
    expect(dayLabel("2026-01-01")).toBe("Jan 1");
    expect(dayLabel("junk")).toBe("junk");
  });
});

describe("progressPct", () => {
  it("is whole percent, 0 for an empty list and never above 100", () => {
    expect(progressPct({ contacts_count: 10, completed_count: 4 })).toBe(40);
    expect(progressPct({ contacts_count: 0, completed_count: 0 })).toBe(0);
    expect(progressPct({ contacts_count: 3, completed_count: 9 })).toBe(100);
  });
});

describe("buildAlerts", () => {
  it("is empty when all is well", () => {
    expect(buildAlerts(view())).toEqual([]);
    expect(buildAlerts(view([camp()]))).toEqual([]);
  });
  it("reports a stalled campaign in words and ignores a paused one", () => {
    const alerts = buildAlerts(view([camp({ stall_reason: "balance" }), camp({ id: "c2", name: "Old", status: "Paused", stall_reason: "balance" })]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe("Spring: Waiting for balance: add funds and it carries on by itself.");
  });
  it("reports call errors and never says the voice vendor's name", () => {
    const [alert] = buildAlerts(view([camp({ errors: 3, last_error: "VAPI rejected the number" })]));
    expect(alert.text).toContain("voice service rejected the number");
    expect(alert.text.toLowerCase()).not.toContain("vapi");
  });
});

describe("setupSteps", () => {
  const none = { agent: false, phone: false, campaign: false, receptionist: false, calls: false, complete: false };
  it("has three steps, none done for a new account", () => {
    expect(setupSteps(none).map((s) => s.done)).toEqual([false, false, false]);
  });
  it("accepts a campaign OR a receptionist for the last step", () => {
    expect(setupSteps({ ...none, campaign: true })[2].done).toBe(true);
    expect(setupSteps({ ...none, receptionist: true })[2].done).toBe(true);
  });
});

describe("greeting and status line", () => {
  it("follows the hour", () => {
    expect(greeting(new Date(2026, 9, 26, 3))).toBe("Good evening");
    expect(greeting(new Date(2026, 9, 26, 8))).toBe("Good morning");
    expect(greeting(new Date(2026, 9, 26, 14))).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 26, 21))).toBe("Good evening");
  });
  it("takes the first word of a name", () => {
    expect(firstName("pat smith")).toBe("Pat");
    expect(firstName("  Qasim  Iqbal ")).toBe("Qasim");
    expect(firstName("")).toBe("");
    expect(firstName(undefined)).toBe("");
  });
  const ready = { agent: true, phone: true, campaign: true, receptionist: false, calls: true, complete: true };
  const counts = (active: number) => ({ active, paused: 0, inactive: 0 });
  it("counts campaigns and things needing a look", () => {
    expect(statusLine({ campaigns: { counts: counts(2), items: [] }, setup: ready }, 0)).toBe("2 campaigns running · everything looks good");
    expect(statusLine({ campaigns: { counts: counts(1), items: [] }, setup: ready }, 1)).toBe("1 campaign running · 1 thing needs a look");
    expect(statusLine({ campaigns: { counts: counts(0), items: [] }, setup: ready }, 3)).toBe("No campaigns running · 3 things need a look");
  });
  it("points a new account at setup instead", () => {
    expect(statusLine({ campaigns: { counts: counts(0), items: [] }, setup: { ...ready, agent: false, complete: false } }, 0)).toMatch(/setting up/);
  });
});

describe("changeParts", () => {
  it("splits a change for the pill and its caption", () => {
    expect(changeParts(12.5, "%", "7d")).toEqual({ delta: 12.5, text: "+12.5%", caption: "vs the 7 days before" });
    expect(changeParts(-2, " pts", "today")).toEqual({ delta: -2, text: "-2.0 pts", caption: "vs yesterday" });
    expect(changeParts(null, "%", "7d")).toBeNull();
  });
});

describe("per-day figures", () => {
  it("is a gap, never a fake zero, on a quiet day", () => {
    expect(dayRate({ answered: 0, finished: 0 })).toBeNull();
    expect(dayRate({ answered: 3, finished: 4 })).toBe(75);
    expect(dayCostPerQualified({ spend: 5, qualified_leads: 0 })).toBeNull();
    expect(dayCostPerQualified({ spend: 5, qualified_leads: 2 })).toBe(2.5);
  });
});

describe("funnelStages", () => {
  const tiles = (calls: number): Tiles => ({
    has_data: calls > 0, has_previous: false,
    calls: { value: calls, previous: 0, change_pct: null },
    answered_rate: { value: 50, answered: 50, finished: 100, previous: null, change_pts: null, not_answered: { total: 50, buckets: {} } },
    qualified_leads: { value: 10, previous: 0, change_pct: null }, leads: { value: 20, previous: 0, change_pct: null },
    minutes: { value: 0, previous: 0, change_pct: null }, spend: { value: 0, previous: 0, change_pct: null },
    cost_per_qualified_lead: { value: null, previous: null, change_pct: null },
  });
  it("is calls, answered, leads, qualified, each as a share of calls", () => {
    const stages = funnelStages(tiles(200));
    expect(stages.map((s) => [s.key, s.value, s.pctOfCalls])).toEqual([["calls", 200, 100], ["answered", 50, 25], ["leads", 20, 10], ["qualified", 10, 5]]);
  });
  it("is empty with no calls, and never above 100%", () => {
    expect(funnelStages(tiles(0))).toEqual([]);
    expect(funnelStages(tiles(10)).every((s) => s.pctOfCalls <= 100)).toBe(true);
  });
});

describe("runningSub", () => {
  it("splits running calls by direction and skips an empty side", () => {
    expect(runningSub({ total: 3, outbound: 2, inbound: 1 })).toBe("2 outbound · 1 inbound");
    expect(runningSub({ total: 2, outbound: 2, inbound: 0 })).toBe("2 outbound");
    expect(runningSub({ total: 1, outbound: 0, inbound: 1 })).toBe("1 inbound");
    expect(runningSub({ total: 0, outbound: 0, inbound: 0 })).toBe("none right now");
  });
});

describe("previousLabel (what a change is measured against)", () => {
  it("names the fixed ranges", () => {
    expect(previousLabel("today")).toBe("yesterday");
    expect(previousLabel("7d")).toBe("the 7 days before");
    expect(previousLabel("30d")).toBe("the 30 days before");
  });
  it("names a custom range by its own length", () => {
    expect(previousLabel("custom", 14)).toBe("the 14 days before");
    expect(previousLabel("custom", 1)).toBe("the day before");
    expect(previousLabel("custom")).toBe("the period before");
  });
  it("flows into the change line and the pill caption", () => {
    expect(changeLine(5, "%", "custom", 10)).toBe("+5.0% vs the 10 days before");
    expect(changeParts(-1, " pts", "custom", 3)?.caption).toBe("vs the 3 days before");
  });
});

describe("customPresets", () => {
  const byKey = (now: Date) => Object.fromEntries(customPresets(now).map((p) => [p.key, [p.from, p.to]]));

  it("offers the six quick picks in order", () => {
    expect(customPresets(new Date(2026, 9, 28)).map((p) => p.label)).toEqual(
      ["Yesterday", "Week to Date", "Month to Date", "Year to Date", "Current Month", "Last Month"]);
  });
  it("works out each range from a Wednesday mid-month (weeks start on Sunday)", () => {
    expect(byKey(new Date(2026, 9, 28))).toEqual({
      yesterday: ["2026-10-27", "2026-10-27"],
      week: ["2026-10-25", "2026-10-28"],
      month: ["2026-10-01", "2026-10-28"],
      year: ["2026-01-01", "2026-10-28"],
      "current-month": ["2026-10-01", "2026-10-31"],
      "last-month": ["2026-09-01", "2026-09-30"],
    });
  });
  it("week to date on a Sunday is just that day", () => {
    expect(byKey(new Date(2026, 9, 25)).week).toEqual(["2026-10-25", "2026-10-25"]);
  });
  it("crosses month and year edges", () => {
    const jan1 = byKey(new Date(2026, 0, 1));
    expect(jan1.yesterday).toEqual(["2025-12-31", "2025-12-31"]);
    expect(jan1["last-month"]).toEqual(["2025-12-01", "2025-12-31"]);
    expect(jan1.year).toEqual(["2026-01-01", "2026-01-01"]);
    const mar1 = byKey(new Date(2026, 2, 1));
    expect(mar1.yesterday).toEqual(["2026-02-28", "2026-02-28"]);          // not a leap year
    expect(mar1["last-month"]).toEqual(["2026-02-01", "2026-02-28"]);
    expect(byKey(new Date(2028, 2, 1)).yesterday).toEqual(["2028-02-29", "2028-02-29"]);
  });
  it("every pick is a valid range within the year the server allows", () => {
    for (const now of [new Date(2026, 0, 1), new Date(2026, 11, 31), new Date(2028, 1, 29)]) {
      for (const p of customPresets(now)) {
        expect(p.from <= p.to).toBe(true);
        expect(Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86_400_000) + 1).toBeLessThanOrEqual(366);
      }
    }
  });
});

describe("hourLabel", () => {
  it("is 12-hour with AM / PM", () => {
    expect([0, 1, 11, 12, 13, 23].map(hourLabel)).toEqual(["12 AM", "1 AM", "11 AM", "12 PM", "1 PM", "11 PM"]);
  });
});

describe("chartPoints", () => {
  const hour = (date: string, h: number, calls: number | null) => ({ date, hour: h, calls, qualified_leads: calls === null ? null : 0, leads: calls === null ? null : 0 });
  const day = (date: string, calls: number) => ({ date, calls, qualified_leads: 0, leads: 0, spend: 0, minutes: 0, answered: 0, finished: 0 });

  it("uses the hours for an hour chart and spells out the tooltip", () => {
    const pts = chartPoints({ chart: { granularity: "hour", hourly: [hour("2026-10-27", 0, 1), hour("2026-10-27", 23, null)] }, trend: [] });
    expect(pts[0]).toMatchObject({ label: "12 AM", tip: "Oct 27, 12 AM – 1 AM", calls: 1 });
    expect(pts[1]).toMatchObject({ label: "11 PM", tip: "Oct 27, 11 PM – 12 AM", calls: null });
  });
  it("labels midnight with the date only when there is more than one day", () => {
    const two = chartPoints({ chart: { granularity: "hour", hourly: [hour("2026-10-26", 0, 0), hour("2026-10-26", 1, 0), hour("2026-10-27", 0, 0)] }, trend: [] });
    expect(two.map((p) => p.label)).toEqual(["Oct 26", "1 AM", "Oct 27"]);
    const one = chartPoints({ chart: { granularity: "hour", hourly: [hour("2026-10-27", 0, 0)] }, trend: [] });
    expect(one[0].label).toBe("12 AM");
  });
  it("uses the days otherwise, ignoring any hours", () => {
    const pts = chartPoints({ chart: { granularity: "day", hourly: [] }, trend: [day("2026-10-26", 4), day("2026-10-27", 6)] });
    expect(pts.map((p) => [p.label, p.calls])).toEqual([["Oct 26", 4], ["Oct 27", 6]]);
  });
  it("counts an hour still to come as nothing when deciding the chart is empty", () => {
    expect(chartIsEmpty([{ label: "a", tip: "a", calls: 0, qualified_leads: 0 }, { label: "b", tip: "b", calls: null, qualified_leads: null }])).toBe(true);
    expect(chartIsEmpty([{ label: "a", tip: "a", calls: 1, qualified_leads: 0 }])).toBe(false);
  });
});

describe("notAnsweredBreakdown", () => {
  const tiles = (calls: number, finished: number, buckets: Record<string, number>): Tiles => {
    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    return {
      has_data: true, has_previous: false,
      calls: { value: calls, previous: 0, change_pct: null },
      answered_rate: { value: 0, answered: finished - total, finished, previous: null, change_pts: null, not_answered: { total, buckets } },
      qualified_leads: { value: 0, previous: 0, change_pct: null }, leads: { value: 0, previous: 0, change_pct: null },
      minutes: { value: 0, previous: 0, change_pct: null }, spend: { value: 0, previous: 0, change_pct: null },
      cost_per_qualified_lead: { value: null, previous: null, change_pct: null },
    };
  };
  it("lists the reasons that happened, biggest first, with Call Consumption's labels", () => {
    const b = notAnsweredBreakdown(tiles(100, 100, { no_answer: 30, busy: 5, voicemail: 5, hung_up: 0, blocked: 0, failed: 9 }));
    expect(b.total).toBe(49);
    expect(b.items.map((i) => [i.label, i.count])).toEqual([["No answer", 30], ["Failed", 9], ["Busy", 5], ["Voicemail", 5]]);   // busy / voicemail tie: fixed order
  });
  it("adds calls with no result yet, but keeps them out of the total", () => {
    const b = notAnsweredBreakdown(tiles(110, 100, { no_answer: 20 }));
    expect(b.total).toBe(20);
    expect(b.items.at(-1)).toEqual({ key: "unfinished", label: "Not finished yet", count: 10 });
  });
  it("is empty when everything finished was answered", () => {
    expect(notAnsweredBreakdown(tiles(50, 50, {})).items).toEqual([]);
  });
});
