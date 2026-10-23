import { describe, expect, it } from "vitest";
import {
  DROP_BUCKETS, defaultFilters, findPreset, periodPresets, dropRateColor, heatColor, matchPreset, dropRateRgb, filterParams, formatDelta, presetRange, rangeDays, rangeError,
  reasonsUrl, sameFilters, trendColorClass, trendIsGood, truncateLabel, ymd,
} from "./callConsumption";

describe("dropRateColor", () => {
  it("runs green -> amber at 50 -> red on the absolute 0-100 scale", () => {
    expect(dropRateRgb(0)).toEqual([25, 135, 84]);
    expect(dropRateRgb(50)).toEqual([245, 158, 11]);
    expect(dropRateRgb(100)).toEqual([220, 53, 69]);
    expect(dropRateColor(25)).toBe("rgb(135, 147, 48)");
  });

  it("gives the same colour for the same percentage wherever it is asked", () => {
    expect(dropRateColor(37.5)).toBe(dropRateColor(37.5));
    expect(dropRateColor(10)).not.toBe(dropRateColor(90));
  });

  it("clamps and survives junk", () => {
    expect(dropRateRgb(-20)).toEqual(dropRateRgb(0));
    expect(dropRateRgb(250)).toEqual(dropRateRgb(100));
    expect(dropRateRgb(null)).toEqual(dropRateRgb(0));
    expect(dropRateRgb(undefined)).toEqual(dropRateRgb(0));
    expect(dropRateRgb(Number.NaN)).toEqual(dropRateRgb(0));
  });
});

describe("trend colours", () => {
  it("a falling drop rate is good news, a falling consumption rate is not", () => {
    expect(trendIsGood(-2, false)).toBe(true);
    expect(trendIsGood(-2, true)).toBe(false);
    expect(trendColorClass(3, true)).toBe("text-success");
    expect(trendColorClass(3, false)).toBe("text-destructive");
    expect(trendColorClass(0, false)).toBe("text-success"); // no change is not bad news
  });

  it("formats signed deltas", () => {
    expect(formatDelta(3.24)).toBe("+3.2");
    expect(formatDelta(-1)).toBe("-1.0");
    expect(formatDelta(0)).toBe("0.0");
  });
});

describe("date ranges", () => {
  const now = new Date(2026, 2, 15, 23, 30); // Sun 15 Mar 2026, late evening local time

  it("uses the local calendar day, not the UTC one", () => {
    expect(ymd(now)).toBe("2026-03-15");
  });

  it("builds every preset", () => {
    expect(presetRange("today", now)).toEqual({ from: "2026-03-15", to: "2026-03-15" });
    expect(presetRange("yesterday", now)).toEqual({ from: "2026-03-14", to: "2026-03-14" });
    expect(presetRange("last7", now)).toEqual({ from: "2026-03-09", to: "2026-03-15" });
    expect(presetRange("last30", now)).toEqual({ from: "2026-02-14", to: "2026-03-15" });
    expect(presetRange("thisMonth", now)).toEqual({ from: "2026-03-01", to: "2026-03-15" });
    expect(presetRange("lastMonth", now)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("last month works across a year boundary and in a leap year", () => {
    expect(presetRange("lastMonth", new Date(2026, 0, 10))).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(presetRange("lastMonth", new Date(2024, 2, 10))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("names the preset a range matches, or custom", () => {
    expect(matchPreset("2026-02-14", "2026-03-15", now)).toBe("last30");
    expect(matchPreset("2026-03-15", "2026-03-15", now)).toBe("today");
    expect(matchPreset("2026-03-01", "2026-03-15", now)).toBe("thisMonth");
    expect(matchPreset("2026-03-02", "2026-03-09", now)).toBe("custom");
  });

  it("counts days inclusively and rejects bad ranges with a message", () => {
    expect(rangeDays("2026-03-02", "2026-03-02")).toBe(1);
    expect(rangeDays("2026-03-02", "2026-03-08")).toBe(7);
    expect(rangeError("2026-03-02", "2026-03-08")).toBeNull();
    expect(rangeError("2026-03-09", "2026-03-02")).toMatch(/on or before/);
    expect(rangeError("", "2026-03-02")).toBeNull(); // an open end is allowed
    expect(rangeError("", "")).toBeNull();
    expect(rangeError("2025-01-01", "2026-03-02")).toMatch(/at most 366/);
    expect(rangeError("2025-03-02", "2026-03-02")).toBeNull(); // exactly 366 days is allowed
  });
});

describe("filter params", () => {
  const base = { ...defaultFilters(), from: "2026-02-14", to: "2026-03-15", tz: "UTC" };

  it("starts with nothing selected, which sends no dates at all (all time)", () => {
    const d = defaultFilters();
    expect([d.from, d.to, d.campaignIds, d.vertical]).toEqual(["", "", [], ""]);
    expect(Object.keys(filterParams(d))).toEqual(["tz"]);
    expect(matchPreset("", "")).toBe("");
  });

  it("sends only what is set", () => {
    expect(filterParams(base)).toEqual({ from: "2026-02-14", to: "2026-03-15", tz: "UTC" });
    expect(
      filterParams({ ...base, campaignIds: ["a", "b"], vertical: "Insurance", agentId: "x", direction: "inbound", disposition: "failed" }),
    ).toEqual({ from: "2026-02-14", to: "2026-03-15", tz: "UTC", campaign_ids: "a,b", vertical: "Insurance", agent_id: "x", direction: "inbound", disposition: "failed" });
  });

  it("sends the chosen states as codes, and nothing when none are chosen", () => {
    expect(defaultFilters().states).toEqual([]);
    expect(filterParams({ ...base, states: ["CO", "NY"] }).states).toBe("CO,NY");
    expect(filterParams(base).states).toBeUndefined();
    expect(sameFilters(base, { ...base, states: ["CO"] })).toBe(false);
  });

  it("sends the chosen phone numbers as `numbers`, and nothing when none are chosen", () => {
    expect(defaultFilters().numberIds).toEqual([]);
    expect(filterParams({ ...base, numberIds: ["n1", "n2"] }).numbers).toBe("n1,n2");
    expect(filterParams(base).numbers).toBeUndefined();
    expect(sameFilters(base, { ...base, numberIds: ["n1"] })).toBe(false);
  });

  it("adds extras but skips empty ones", () => {
    expect(filterParams(base, { campaign_id: "c1", nothing: undefined, blank: "" })).toMatchObject({ campaign_id: "c1" });
    expect(Object.keys(filterParams(base, { nothing: undefined, blank: "" })).sort()).toEqual(["from", "to", "tz"]);
  });

  it("knows when two filter sets would give the same report", () => {
    expect(sameFilters(base, { ...base })).toBe(true);
    expect(sameFilters(base, { ...base, vertical: "Legal" })).toBe(false);
    expect(sameFilters(base, { ...base, campaignIds: ["a"] })).toBe(false);
  });

  it("the drill-down link carries only ids, dates and zone", () => {
    const url = reasonsUrl("camp-1", { ...base, vertical: "Insurance", direction: "inbound" });
    const q = new URL(url, "http://x").searchParams;
    expect(q.get("campaign_id")).toBe("camp-1");
    expect(q.get("from")).toBe("2026-02-14");
    expect(q.get("direction")).toBe("inbound");
    expect(q.get("vertical")).toBeNull();
  });
});

describe("labels", () => {
  it("shortens long axis labels only", () => {
    expect(truncateLabel("short")).toBe("short");
    expect(truncateLabel("a very long campaign name", 10)).toBe("a very lon…");
    expect(truncateLabel("a very long campaign name", 10)).toHaveLength(11); // max kept characters + the ellipsis
    expect(truncateLabel("exactly ten", 11)).toBe("exactly ten");
    expect(truncateLabel("")).toBe("");
    expect(truncateLabel("N".repeat(30))).toBe(`${"N".repeat(22)}…`); // spec default: 22
  });

  it("keeps the six drop reasons in the documented order", () => {
    expect([...DROP_BUCKETS]).toEqual(["no_answer", "busy", "voicemail", "hung_up", "blocked", "failed"]);
  });
});

describe("heatColor", () => {
  it("runs pale mint -> bright mint -> dark teal", () => {
    expect(heatColor(0)).toBe("rgb(233, 247, 242)");
    expect(heatColor(25)).toBe("rgb(112, 219, 184)");
    expect(heatColor(100)).toBe("rgb(63, 127, 114)");
  });
  it("clamps and survives junk", () => {
    expect(heatColor(-5)).toBe(heatColor(0));
    expect(heatColor(500)).toBe(heatColor(100));
    expect(heatColor(Number.NaN)).toBe(heatColor(0));
  });
});

describe("periodPresets", () => {
  const wed = new Date(2026, 2, 18); // Wed 18 Mar 2026; this week is Sun Mar 15 - Sat Mar 21
  const pick = (list: ReturnType<typeof periodPresets>, v: string) => list.find((p) => p.value === v)!;

  it("weekly: whole Sunday-Saturday weeks ending at the last finished one", () => {
    const l = periodPresets("weekly", false, wed);
    expect(l.map((p) => p.label)).toEqual(["Last 4 weeks", "Last 8 weeks", "Last 12 weeks", "Last 26 weeks"]);
    expect(pick(l, "w4")).toMatchObject({ from: "2026-02-15", to: "2026-03-14" });
    expect(pick(l, "w8")).toMatchObject({ from: "2026-01-18", to: "2026-03-14" });
    for (const p of l) {
      expect(new Date(`${p.from}T00:00:00`).getDay()).toBe(0); // starts on a Sunday
      expect(new Date(`${p.to}T00:00:00`).getDay()).toBe(6);   // ends on a Saturday
    }
  });

  it("weekly: including the current week extends the end to its Saturday", () => {
    const l = periodPresets("weekly", true, wed);
    expect(pick(l, "w4")).toMatchObject({ from: "2026-02-22", to: "2026-03-21" });
  });

  it("monthly: whole calendar months ending at the last finished one", () => {
    const l = periodPresets("monthly", false, wed);
    expect(l.map((p) => p.label)).toEqual(["Last 3 months", "Last 6 months", "Last 12 months", "This year"]);
    expect(pick(l, "m3")).toMatchObject({ from: "2025-12-01", to: "2026-02-28" });
    expect(pick(l, "m12")).toMatchObject({ from: "2025-03-01", to: "2026-02-28" });
    expect(pick(l, "ytd")).toMatchObject({ from: "2026-01-01", to: "2026-02-28" });
  });

  it("monthly: including the current month ends at its last day", () => {
    const l = periodPresets("monthly", true, wed);
    expect(pick(l, "m3")).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
    expect(pick(l, "ytd")).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
  });

  it("handles a leap-year February and the year boundary", () => {
    expect(pick(periodPresets("monthly", false, new Date(2024, 2, 10)), "m3")).toMatchObject({ from: "2023-12-01", to: "2024-02-29" });
    expect(pick(periodPresets("monthly", false, new Date(2026, 0, 20)), "m3")).toMatchObject({ from: "2025-10-01", to: "2025-12-31" });
  });

  it("'This year' in January (nothing finished yet this year) falls back to the current month, never a backwards range", () => {
    const ytd = pick(periodPresets("monthly", false, new Date(2026, 0, 20)), "ytd");
    expect(ytd).toMatchObject({ from: "2026-01-01", to: "2026-01-31" });
    expect(ytd.from <= ytd.to).toBe(true);
  });

  it("finds the preset a range belongs to", () => {
    const l = periodPresets("weekly", false, wed);
    expect(findPreset(l, "2026-02-15", "2026-03-14")?.value).toBe("w4");
    expect(findPreset(l, "2026-02-16", "2026-03-14")).toBeUndefined();
  });
});
