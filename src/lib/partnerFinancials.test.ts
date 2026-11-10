import { describe, expect, it } from "vitest";
import { FINANCE_COLORS, FINANCE_SERIES, financeFilename, financePoints, owedWording, type FinanceRow } from "./partnerFinancials";

const row = (key: string, start: string, end: string, over: Partial<FinanceRow> = {}): FinanceRow => ({
  key, start, end, billed: 0, platform_cost: 0, profit: 0, commission: 0, paid: 0, owed_start: 0, owed: 0, net_kept: 0, ...over,
});

describe("financePoints", () => {
  it("gives each period a short axis label and its full name for the tooltip, keeping the order and the three figures", () => {
    const periods = [row("2026-10-01", "2026-10-01", "2026-10-31", { net_kept: 3.2, commission: 0.8, paid: 0.4 }), row("2026-11-01", "2026-11-01", "2026-11-06")];
    const pts = financePoints(periods, "month", "en-US");
    expect(pts.map((p) => p.label)).toEqual(["Oct 26", "Nov 26"]);
    expect(pts[0]).toMatchObject({ key: "2026-10-01", tip: "October 2026", net_kept: 3.2, commission: 0.8, paid: 0.4 });
  });
  it("labels weeks and days by date and years by year", () => {
    expect(financePoints([row("2026-11-02", "2026-11-02", "2026-11-08")], "week", "en-US")[0]).toMatchObject({ label: "Nov 2", tip: "Week of Nov 2, 2026" });
    expect(financePoints([row("2026-11-06", "2026-11-06", "2026-11-06")], "day", "en-US")[0].label).toBe("Nov 6");
    expect(financePoints([row("2025-01-01", "2025-01-01", "2025-12-31")], "year", "en-US")[0]).toMatchObject({ label: "2025", tip: "2025" });
  });
  it("is empty for no periods", () => {
    expect(financePoints([], "month")).toEqual([]);
  });
});

describe("owedWording", () => {
  it("says still owed, settled or overpaid, going by whole cents", () => {
    expect(owedWording(0.6)).toEqual({ label: "Commission still owed", tone: "owed" });
    expect(owedWording(0)).toEqual({ label: "Commission still owed", tone: "settled" });
    expect(owedWording(0.004)).toEqual({ label: "Commission still owed", tone: "settled" });
    expect(owedWording(-1.5)).toEqual({ label: "Overpaid to partners", tone: "overpaid" });
  });
});

describe("chart series and file name", () => {
  it("has one colour per series in both modes, all different", () => {
    for (const mode of [FINANCE_COLORS.light, FINANCE_COLORS.dark]) {
      const colours = FINANCE_SERIES.map((s) => mode[s.key]);
      expect(new Set(colours).size).toBe(FINANCE_SERIES.length);
    }
  });
  it("names the file from the dates on screen", () => {
    expect(financeFilename({ group: "month", start: "2025-12-01", end: "2026-11-06" })).toBe("financial-summary-month-2025-12-01_to_2026-11-06.csv");
  });
});
