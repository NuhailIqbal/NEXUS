import { describe, expect, it, vi } from "vitest";
import {
  ACCENT, DARK_CHART_THEME, HEATMAP_DARK_SCALE, HEATMAP_GREEN_SCALE, HEATMAP_METRICS, HYPERLINK_MIN_DROP_RATE, LIGHT_CHART_THEME, PX_PER_BAR,
  PX_PER_CAMPAIGN, RANKING_MIN_HEIGHT, RISK_COLORS, STACKED_MIN_WIDTH, buildCombo, buildDonut, buildHeatmap,
  buildHourlyTrend, tickInt, buildRanking, buildStateHeatmap, heatRanges, STATE_HEATMAP_MIN_HEIGHT, STATE_HEATMAP_ROW_PX, buildStacked, escapeHtml, getRiskColor, heatmapMetricValue, isDrillable,
  type ComboRow, type DispositionRow, type HeatCell, type StateHeatCell, type MixRow, type RankingRow, type TrendPoint,
} from "./callConsumptionCharts";
import { BUCKET_COLORS, DROP_BUCKETS } from "./callConsumption";

const T = LIGHT_CHART_THEME;
// Apex options are deeply optional; these tests reach into them freely.
/* eslint-disable @typescript-eslint/no-explicit-any */
const opt = (o: any) => o as any;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const hourLabel = (h: number) => `${String(h % 12 || 12).padStart(2, "0")}:00 ${h < 12 ? "AM" : "PM"}`;
const cell = (d: number, h: number, total = 0, dropped = 0): HeatCell => ({
  day_of_week: d, day_label: DAYS[d], hour: h, hour_label: hourLabel(h), total_calls: total, consumed_calls: total - dropped,
  dropped_calls: dropped, consumption_pct: total ? +(((total - dropped) / total) * 100).toFixed(1) : 0,
  drop_pct: total ? +((dropped / total) * 100).toFixed(1) : 0,
});
const grid = (over: Record<string, [number, number]> = {}) =>
  Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => cell(d, h, ...(over[`${d}:${h}`] ?? [0, 0])))).flat();

describe("risk colours", () => {
  it("is green below 30, amber from 30, red from 50", () => {
    expect(getRiskColor(0)).toBe(RISK_COLORS.success);
    expect(getRiskColor(29.99)).toBe(RISK_COLORS.success);
    expect(getRiskColor(30)).toBe(RISK_COLORS.warning);
    expect(getRiskColor(49.99)).toBe(RISK_COLORS.warning);
    expect(getRiskColor(50)).toBe(RISK_COLORS.danger);
    expect(getRiskColor(100)).toBe(RISK_COLORS.danger);
  });
  it("uses the spec's colours", () => {
    expect(RISK_COLORS).toEqual({ danger: "#ff3366", warning: "#fbbc06", success: "#05a34a" });
    expect(HEATMAP_GREEN_SCALE).toEqual(["#d2f0e5", "#b7ecd9", "#7cfdd3", "#3ecfa0", "#0f8b72", "#0b5c4b"]);
    expect(ACCENT).toBe("#448f7b");
  });
});

describe("1. heatmap", () => {
  const cells = grid({ "1:10": [20, 10], "6:3": [4, 1], "0:23": [50, 5] });

  it("is 7 series of 24 points, ascending by day so Apex puts Saturday on top and Sunday at the bottom", () => {
    const { series } = buildHeatmap(cells, "dropRate", T);
    const s = series as { name: string; data: { x: string; y: number }[] }[];
    expect(s.map((x) => x.name)).toEqual(DAYS);
    expect(s.every((x) => x.data.length === 24)).toBe(true);
    expect(s[1].data[10]).toEqual({ x: "10:00 AM", y: 50 });
    expect(s[0].data.map((p) => p.x)).toEqual(Array.from({ length: 24 }, (_, h) => hourLabel(h)));
  });

  it("orders hours and days even when the API sends the cells shuffled", () => {
    const shuffled = [...cells].sort((a, b) => ((a.hour * 31 + a.day_of_week * 7) % 13) - ((b.hour * 31 + b.day_of_week * 7) % 13));
    const s = buildHeatmap(shuffled, "dropRate", T).series as { name: string; data: { x: string }[] }[];
    expect(s.map((x) => x.name)).toEqual(DAYS);
    expect(s[3].data.map((p) => p.x)).toEqual(Array.from({ length: 24 }, (_, h) => hourLabel(h)));
  });

  it("plots the chosen metric, switchable without new data", () => {
    const y = (m: Parameters<typeof buildHeatmap>[1]) => (buildHeatmap(cells, m, T).series as any)[1].data[10].y;
    expect(y("dropRate")).toBe(50);
    expect(y("consumption")).toBe(50);
    expect(y("volume")).toBe(20);
    expect(heatmapMetricValue(cell(0, 0, 8, 2), "consumption")).toBe(75);
    expect(HEATMAP_METRICS.map((m) => m.value)).toEqual(["dropRate", "consumption", "volume"]);
  });

  it("uses one explicit 6-step scale for the whole grid, from 0 to the grid's own maximum", () => {
    const ranges = opt(buildHeatmap(cells, "volume", T).options).plotOptions.heatmap.colorScale.ranges as { from: number; to: number; color: string }[];
    expect(ranges.map((r) => r.color)).toEqual(HEATMAP_GREEN_SCALE);
    expect(ranges[0].from).toBe(0);
    expect(ranges[5].to).toBe(50); // the busiest cell
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].from).toBeCloseTo(ranges[i - 1].to, 9); // no gaps
    expect(ranges.every((r) => r.from <= r.to)).toBe(true);
    // Percent metrics scale to the grid's own max (50% here), not to a fixed 100.
    const pct = opt(buildHeatmap(cells, "dropRate", T).options).plotOptions.heatmap.colorScale.ranges;
    expect(pct[5].to).toBe(50);
  });

  it("an all-zero grid doesn't divide by zero (the spec's `|| 1`)", () => {
    const ranges = opt(buildHeatmap(grid(), "dropRate", T).options).plotOptions.heatmap.colorScale.ranges as { from: number; to: number }[];
    expect(ranges.every((r) => Number.isFinite(r.from) && Number.isFinite(r.to))).toBe(true);
    expect(ranges[0].from).toBe(0);
    expect(ranges[5].to).toBe(1);
  });

  it("has the spec's chart settings", () => {
    const o = opt(buildHeatmap(cells, "dropRate", T).options);
    expect(o.chart).toMatchObject({ height: 320, type: "heatmap", redrawOnWindowResize: true, redrawOnParentResize: true });
    expect(o.chart.toolbar).toEqual({ show: false }); // no menu icon
    expect(o.dataLabels.enabled).toBe(false);
    expect(o.legend.show).toBe(false);
    expect(o.plotOptions.heatmap.radius).toBe(2);
    expect(o.stroke).toEqual({ width: 1, colors: ["#ffffff"] }); // white lines between cells on the light card, like the reference
    expect(o.xaxis.labels).toMatchObject({ rotate: 0, rotateAlways: false }); // level hour labels
    expect(o.xaxis.type).toBe("category");
    expect(o.noData.text).toBe("No Data Found");
  });

  it("the tooltip shows all three metrics whichever is plotted, and nothing for an unknown cell", () => {
    for (const metric of ["dropRate", "consumption", "volume"] as const) {
      const tip = opt(buildHeatmap(cells, metric, T).options).tooltip.custom({ seriesIndex: 1, dataPointIndex: 10 }) as string;
      expect(tip).toContain("Mon 10:00 AM");
      expect(tip).toContain("Total Calls: 20");
      expect(tip).toContain("Consumed: 10 (50%)");
      expect(tip).toContain("Dropped: 10 (50%)");
    }
    expect(opt(buildHeatmap(cells, "dropRate", T).options).tooltip.custom({ seriesIndex: 99, dataPointIndex: 0 })).toBe("");
  });

  it("the tooltip maps a series back to its weekday even when the grid doesn't start on Sunday", () => {
    const onlyMonFri = grid({ "5:7": [10, 3] }).filter((c) => c.day_of_week === 1 || c.day_of_week === 5);
    const tip = opt(buildHeatmap(onlyMonFri, "dropRate", T).options).tooltip.custom({ seriesIndex: 1, dataPointIndex: 7 }) as string;
    expect(tip).toContain("Fri 07:00 AM");
    expect(tip).toContain("Total Calls: 10");
  });
});

describe("2. hourly trend", () => {
  const pts: TrendPoint[] = [5, 1, 3].map((h) => ({ hour: h, hour_label: hourLabel(h), total_calls: h * 10, dropped_calls: h, drop_pct: h * 2 }));

  it("sorts by hour without touching the caller's array", () => {
    const copy = [...pts];
    const { series, options } = buildHourlyTrend(pts, T);
    expect((series as any)[0].data).toEqual([10, 30, 50]);
    expect((series as any)[1].data).toEqual([2, 6, 10]);
    expect(opt(options).xaxis.categories).toEqual([hourLabel(1), hourLabel(3), hourLabel(5)]);
    expect(pts).toEqual(copy);
  });

  it("is a column + line combo with the spec's settings", () => {
    const { series, options } = buildHourlyTrend(pts, T);
    const o = opt(options);
    expect((series as any).map((s: any) => [s.name, s.type])).toEqual([["Total calls", "column"], ["Drop rate %", "line"]]);
    expect(o.chart).toMatchObject({ height: 350, type: "line", redrawOnWindowResize: true, redrawOnParentResize: true });
    expect(o.stroke).toEqual({ width: [0, 3], curve: "smooth" });
    expect(o.colors).toEqual([ACCENT, "#e0507a"]);
    expect(o.plotOptions.bar).toEqual({ columnWidth: "60%", borderRadius: 3 });
    expect(o.fill.opacity).toEqual([1, 0.15]);
    expect(o.legend.position).toBe("top");
    expect(o.tooltip.shared).toBe(true);
  });

  it("pins the drop-rate axis to 0-100 so a wiggle never looks like a crisis", () => {
    const y = opt(buildHourlyTrend(pts, T).options).yaxis;
    expect(y[1]).toMatchObject({ opposite: true, min: 0, max: 100 });
    expect(y[0].min).toBeUndefined();
  });

  it("survives no points", () => {
    expect(buildHourlyTrend([], T).series).toEqual([{ name: "Total calls", type: "column", data: [] }, { name: "Drop rate %", type: "line", data: [] }]);
  });
});

describe("4. volume + drop-rate combo", () => {
  const rows: ComboRow[] = [
    { key: "a", name: "Spring Push", total_calls: 14, consumed_calls: 8, dropped_calls: 6, drop_pct: 42.857142 },
    { key: "b", name: "Spring Push", total_calls: 2, consumed_calls: 1, dropped_calls: 1, drop_pct: 50 }, // same name, other campaign
    { key: "c", name: "A <b>very</b> long campaign name that overflows", total_calls: 1, consumed_calls: 1, dropped_calls: 0, drop_pct: 0 },
  ];

  it("plots drop rate (area) and dropped calls (column), rate rounded to 2 decimals", () => {
    const { series } = buildCombo(rows, T);
    expect((series as any).map((s: any) => [s.name, s.type])).toEqual([["Drop Rate %", "area"], ["Dropped Calls", "column"]]);
    expect((series as any)[0].data).toEqual([42.86, 50, 0]);
    expect((series as any)[1].data).toEqual([6, 1, 0]);
  });

  it("is a fixed 350px chart with no toolbar, zoom or pan, however many segments there are", () => {
    for (const n of [3, 40]) {
      const many = Array.from({ length: n }, (_, i) => ({ ...rows[0], key: `k${i}`, name: `S${i}` }));
      const o = opt(buildCombo(many, T).options);
      expect(o.chart).toMatchObject({ height: 350, type: "area", stacked: false });
      expect(o.chart.toolbar).toEqual({ show: false });
      expect(o.chart.zoom.enabled).toBe(false);
    }
  });

  it("draws the rate as a bare line over solid bars", () => {
    const o = opt(buildCombo(rows, T).options);
    expect(o.colors).toEqual([RISK_COLORS.danger, ACCENT]);
    expect(o.fill).toEqual({ type: ["solid", "solid"], opacity: [0, 0.85] });
    expect(o.stroke).toEqual({ show: true, curve: "smooth", width: [3, 0] });
    expect(o.markers).toMatchObject({ size: [4, 0], strokeWidth: 0, hover: { size: 6 } });
    expect(o.dataLabels.enabled).toBe(false);
    expect(o.legend).toEqual({ show: true, position: "top", horizontalAlign: "center" });
  });

  it("truncates only the rendered tick, never the category the tooltip reads", () => {
    const o = opt(buildCombo(rows, T).options);
    expect(o.xaxis.categories[2]).toBe(rows[2].name);
    const tick = o.xaxis.labels.formatter(rows[2].name) as string;
    expect(tick.endsWith("…")).toBe(true);
    expect(tick).toBe(`${rows[2].name.slice(0, 22)}…`);
    expect(o.xaxis.labels.formatter("short")).toBe("short");
    expect(o.xaxis.labels.rotate).toBe(-45);
    expect(o.xaxis.labels.hideOverlappingLabels).toBeUndefined(); // Apex default: overlapping ticks hide
  });

  it("pins the rate axis to 0-100 and formats both axes", () => {
    const y = opt(buildCombo(rows, T).options).yaxis;
    expect(y[0]).toMatchObject({ seriesName: "Drop Rate %", opposite: true, min: 0, max: 100 });
    expect(y[0].labels.formatter(40)).toBe("40%");
    expect(y[1].labels.formatter(12345)).toBe("12,345");
  });

  it("tooltip reads the hovered row by position (two campaigns can share a name) and escapes HTML", () => {
    const tip = opt(buildCombo(rows, T).options).tooltip;
    expect(tip.shared).toBe(true);
    expect(tip.intersect).toBe(false);
    expect(tip.custom({ dataPointIndex: 0 })).toContain("Total Calls: <strong>14</strong>");
    expect(tip.custom({ dataPointIndex: 1 })).toContain("Total Calls: <strong>2</strong>");
    expect(tip.custom({ dataPointIndex: 0 })).toContain("Drop Rate: <strong>42.9%</strong>");
    expect(tip.custom({ dataPointIndex: 2 })).not.toContain("<b>very</b>");
    expect(tip.custom({ dataPointIndex: 2 })).toContain("&lt;b&gt;very&lt;/b&gt;");
    expect(tip.custom({ dataPointIndex: 99 })).toBe("");
  });

  it("copes with a null drop rate", () => {
    const { series } = buildCombo([{ ...rows[0], drop_pct: null as unknown as number }], T);
    expect((series as any)[0].data).toEqual([0]);
  });
});

describe("5. disposition stacked bar", () => {
  const seg = (key: string, name: string, counts: Partial<Record<(typeof DROP_BUCKETS)[number], number>>): DispositionRow[] =>
    Object.entries(counts).map(([d, calls]) => ({ key, name, disposition: d as DispositionRow["disposition"], label: d, calls: calls! }));
  const rows = [...seg("a", "Small", { busy: 1 }), ...seg("b", "Big", { failed: 6, no_answer: 4 }), ...seg("c", "Big", { busy: 2 })];

  it("lists segments busiest first and tells apart two segments that share a name", () => {
    const { options } = buildStacked(rows, T);
    expect(opt(options).xaxis.categories).toEqual(["Big", "Big", "Small"]);
  });

  it("makes one zero-filled series per used reason, in the fixed reason order, in the reason's own colour", () => {
    const { series, options } = buildStacked(rows, T);
    const s = series as { name: string; data: number[] }[];
    expect(s.map((x) => x.name)).toEqual(["No answer", "Busy", "Failed"]);
    expect(s[0].data).toEqual([4, 0, 0]);
    expect(s[1].data).toEqual([0, 2, 1]);
    expect(s[2].data).toEqual([6, 0, 0]);
    expect(opt(options).colors).toEqual([BUCKET_COLORS.no_answer, BUCKET_COLORS.busy, BUCKET_COLORS.failed]);
  });

  it("grows 45px per segment with a 700px floor", () => {
    expect(PX_PER_CAMPAIGN).toBe(45);
    expect(STACKED_MIN_WIDTH).toBe(700);
    expect(buildStacked(rows, T).width).toBe(700);
    const many = Array.from({ length: 40 }, (_, i) => seg(`k${i}`, `Seg ${i}`, { busy: 1 })).flat();
    const wide = buildStacked(many, T);
    expect(wide.width).toBe(1800);
    expect(opt(wide.options).chart).toMatchObject({ type: "bar", height: 400, stacked: true });
  });

  it("shows every label (the chart is wide enough) and truncates only the tick", () => {
    const o = opt(buildStacked([...seg("x", "N".repeat(40), { busy: 1 })], T).options);
    expect(o.xaxis.labels).toMatchObject({ rotate: -45, hideOverlappingLabels: false });
    expect(o.xaxis.labels.formatter("N".repeat(40)).length).toBe(23);
    expect(o.xaxis.categories[0]).toBe("N".repeat(40));
  });

  it("tooltip follows the cursor (fixed would draw off-screen on a wide chart) and keeps the full name", () => {
    const tip = opt(buildStacked(rows, T).options).tooltip;
    expect(tip).toMatchObject({ shared: true, intersect: false, followCursor: true });
    expect(tip.fixed).toBeUndefined();
    expect(tip.x.formatter("A really long full segment name that was truncated on the axis")).toBe("A really long full segment name that was truncated on the axis");
  });

  it("is fast on hundreds of segments (one pass, no find per cell)", () => {
    const many = Array.from({ length: 800 }, (_, i) => seg(`k${i}`, `Seg ${i}`, { busy: 1, failed: 2, voicemail: 3, no_answer: 4 })).flat();
    const t0 = performance.now();
    const { series } = buildStacked(many, T);
    expect(performance.now() - t0).toBeLessThan(500);
    expect((series as any)[0].data).toHaveLength(800);
  });

  it("handles no rows", () => {
    const r = buildStacked([], T);
    expect(r.series).toEqual([]);
    expect(r.width).toBe(700);
  });
});

describe("6. disposition donut", () => {
  const rows: MixRow[] = [
    { disposition: "failed", label: "Failed", calls: 4000, pct_of_dropped: 57.1 },
    { disposition: "voicemail", label: "Voicemail", calls: 3, pct_of_dropped: 42.9 },
  ];

  it("plots counts with the reason colours (the same ones the stacked bar uses)", () => {
    const { series, options } = buildDonut(rows, T);
    expect(series).toEqual([4000, 3]);
    expect(opt(options).labels).toEqual(["Failed", "Voicemail"]);
    expect(opt(options).colors).toEqual([BUCKET_COLORS.failed, BUCKET_COLORS.voicemail]);
    expect(opt(options).chart).toMatchObject({ type: "donut", height: 320 });
  });

  it("always shows the total in the centre", () => {
    const labels = opt(buildDonut(rows, T).options).plotOptions.pie.donut.labels;
    expect(opt(buildDonut(rows, T).options).plotOptions.pie.donut.size).toBe("65%");
    expect(labels.total).toMatchObject({ show: true, showAlways: true, label: "TOTAL" });
    expect(labels.total.formatter({ globals: { seriesTotals: [4000, 3] } })).toBe("4,003");
    expect(labels.value.formatter("4000")).toBe("4,000");
  });

  it("puts the counts in the legend, not on the slices", () => {
    const o = opt(buildDonut(rows, T).options);
    expect(o.dataLabels.enabled).toBe(false);
    expect(o.legend.position).toBe("right");
    expect(o.legend.formatter("Failed", { w: { globals: { series: [4000, 3] } }, seriesIndex: 0 })).toBe("Failed: 4,000");
    expect(o.tooltip.y.formatter(4000)).toBe("4,000");
  });
});

describe("7. ranking", () => {
  const rows: RankingRow[] = [
    { key: "c1", name: "Worst", total_calls: 10, dropped_calls: 9, drop_rate_pct: 90 },
    { key: "c2", name: "Mid", total_calls: 10, dropped_calls: 4, drop_rate_pct: 40 },
    { key: "c3", name: "Fine", total_calls: 10, dropped_calls: 1, drop_rate_pct: 10 },
    { key: "c4", name: "Clean", total_calls: 10, dropped_calls: 0, drop_rate_pct: 0 },
    { key: "", name: "No campaign", total_calls: 5, dropped_calls: 4, drop_rate_pct: 80 },
  ];

  it("colours each bar by risk and shows a single distributed series", () => {
    const { series, options } = buildRanking(rows, T);
    const o = opt(options);
    expect(series).toEqual([{ name: "Drop Rate %", data: [90, 40, 10, 0, 80] }]);
    expect(o.colors).toEqual([RISK_COLORS.danger, RISK_COLORS.warning, RISK_COLORS.success, RISK_COLORS.success, RISK_COLORS.danger]);
    expect(o.plotOptions.bar).toEqual({ horizontal: true, distributed: true, barHeight: "80%" });
    expect(o.legend.show).toBe(false); // `distributed` would otherwise list one legend entry per bar
  });

  it("uses the app font so Apex measures labels correctly", () => {
    expect(opt(buildRanking(rows, T).options).chart.fontFamily).toMatch(/^Inter/);
  });

  it("gives each bar 28px of height, with a 350px floor", () => {
    expect([PX_PER_BAR, RANKING_MIN_HEIGHT]).toEqual([28, 350]);
    expect(buildRanking(rows, T).height).toBe(350);
    const many = Array.from({ length: 60 }, (_, i) => ({ ...rows[0], key: `k${i}`, name: `S${i}` }));
    const r = buildRanking(many, T);
    expect(r.height).toBe(1680);
    expect(opt(r.options).chart.height).toBe(1680);
  });

  it("labels every bar, even a 0% one, on a background box so it stays readable", () => {
    const dl = opt(buildRanking(rows, T).options).dataLabels;
    expect(dl.enabled).toBe(true);
    expect(dl.background).toMatchObject({ enabled: true, foreColor: "#fff", borderRadius: 2, padding: 4, opacity: 0.9, borderWidth: 0 });
    expect(dl.formatter(0)).toBe("0.0%");
    expect(dl.formatter(42.857)).toBe("42.9%");
  });

  it("pins the percentage axis and formats the value axis as a percentage", () => {
    const x = opt(buildRanking(rows, T).options).xaxis;
    expect(x).toMatchObject({ min: 0, max: 100 });
    expect(x.labels.formatter("40")).toBe("40%");
    expect(x.categories).toEqual(["Worst", "Mid", "Fine", "Clean", "No campaign"]);
  });

  it("tints only the drill-down links (a campaign id AND some drops), and says which ones those are", () => {
    expect(HYPERLINK_MIN_DROP_RATE).toBe(0);
    expect(rows.map(isDrillable)).toEqual([true, true, true, false, false]);
    expect(isDrillable(undefined)).toBe(false);
    const colors = opt(buildRanking(rows, T).options).yaxis.labels.style.colors;
    expect(colors).toEqual([ACCENT, ACCENT, ACCENT, T.mutedLabel, T.mutedLabel]);
  });

  it("clicking a label or a bar drills into that campaign, but never a 0% row, an id-less row or a stale index", () => {
    const onDrill = vi.fn();
    const ev = opt(buildRanking(rows, T, onDrill).options).chart.events;
    ev.xAxisLabelClick({}, {}, { labelIndex: 0 });
    expect(onDrill).toHaveBeenLastCalledWith(rows[0]);
    ev.dataPointSelection({}, {}, { dataPointIndex: 2 });
    expect(onDrill).toHaveBeenLastCalledWith(rows[2]);
    onDrill.mockClear();
    ev.xAxisLabelClick({}, {}, { labelIndex: 3 });      // 0%
    ev.xAxisLabelClick({}, {}, { labelIndex: 4 });      // no campaign id
    ev.xAxisLabelClick({}, {}, { labelIndex: 99 });     // out of range
    ev.xAxisLabelClick({}, {}, {});                     // no index at all
    ev.xAxisLabelClick({}, {}, undefined);
    expect(onDrill).not.toHaveBeenCalled();
  });

  it("works with no drill handler (Vertical and State pages)", () => {
    const ev = opt(buildRanking(rows, T).options).chart.events;
    expect(() => ev.xAxisLabelClick({}, {}, { labelIndex: 0 })).not.toThrow();
  });
});

describe("theme", () => {
  it("light and dark differ and reach every chart", () => {
    expect(LIGHT_CHART_THEME.foreColor).not.toBe(DARK_CHART_THEME.foreColor);
    const cells = grid({ "1:10": [20, 10] });
    for (const th of [LIGHT_CHART_THEME, DARK_CHART_THEME]) {
      expect(opt(buildHeatmap(cells, "dropRate", th).options).chart.foreColor).toBe(th.foreColor);
      expect(opt(buildHeatmap(cells, "dropRate", th).options).tooltip.theme).toBe(th.mode);
      expect(opt(buildHeatmap(cells, "dropRate", th).options).stroke.colors).toEqual([th.cellStroke]);
      expect(opt(buildHourlyTrend([], th).options).grid.borderColor).toBe(th.gridColor);
      expect(opt(buildCombo([], th).options).chart.foreColor).toBe(th.foreColor);
      expect(opt(buildStacked([], th).options).tooltip.theme).toBe(th.mode);
      expect(opt(buildDonut([], th).options).chart.foreColor).toBe(th.foreColor);
      expect(opt(buildRanking([], th).options).chart.foreColor).toBe(th.foreColor);
    }
  });

  it("every chart says 'No Data Found' when empty", () => {
    for (const o of [buildHeatmap([], "dropRate", T), buildHourlyTrend([], T), buildCombo([], T), buildStacked([], T), buildDonut([], T), buildRanking([], T)]) {
      expect(opt(o.options).noData).toEqual({ text: "No Data Found", align: "center", verticalAlign: "middle" });
    }
  });
});

describe("escapeHtml", () => {
  it("neutralises markup that a campaign name could carry into a tooltip", () => {
    expect(escapeHtml(`<img src=x onerror="a('b')">&`)).toBe("&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;");
    expect(escapeHtml("plain")).toBe("plain");
  });
});

describe("tickInt", () => {
  it("keeps fractional ticks distinct instead of rounding them into duplicates", () => {
    expect([0, 0.5, 1, 1.5, 2].map(tickInt)).toEqual(["0", "0.5", "1", "1.5", "2"]);
    expect(tickInt(12345)).toBe("12,345");
  });
});

describe("state x hour heatmap", () => {
  const NAMES: Record<string, string> = { TX: "Texas", CA: "California", NY: "New York" };
  const scell = (state: string, h: number, total = 0, dropped = 0): StateHeatCell => ({
    state, state_name: NAMES[state], hour: h, hour_label: hourLabel(h), total_calls: total, consumed_calls: total - dropped,
    dropped_calls: dropped, consumption_pct: total ? +(((total - dropped) / total) * 100).toFixed(1) : 0,
    drop_pct: total ? +((dropped / total) * 100).toFixed(1) : 0,
  });
  const grid = (states: string[], over: Record<string, [number, number]> = {}) =>
    states.flatMap((st) => Array.from({ length: 24 }, (_, h) => scell(st, h, ...(over[`${st}:${h}`] ?? [0, 0]))));
  const cells = grid(["TX", "CA", "NY"], { "TX:10": [100, 90], "CA:15": [20, 2], "NY:9": [4, 4] });

  it("one row per state with 24 hours, the busiest state drawn at the top (Apex draws series bottom-up)", () => {
    const { series } = buildStateHeatmap(cells, ["TX", "CA", "NY"], "dropRate", T);
    const s = series as { name: string; data: { x: string; y: number }[] }[];
    expect(s.map((x) => x.name)).toEqual(["New York", "California", "Texas"]);
    expect(s.every((x) => x.data.length === 24)).toBe(true);
    expect(s[2].data[10]).toEqual({ x: "10:00 AM", y: 90 });
  });

  it("shows only the states asked for, and scales colours over those cells only", () => {
    const { series, options } = buildStateHeatmap(cells, ["CA", "NY"], "volume", T);
    expect((series as any).map((x: any) => x.name)).toEqual(["New York", "California"]);
    const ranges = opt(options).plotOptions.heatmap.colorScale.ranges;
    expect(ranges[5].to).toBe(20); // Texas's 100 calls are not shown, so they don't stretch the scale
    expect(ranges.map((r: any) => r.color)).toEqual(HEATMAP_GREEN_SCALE);
  });

  it("grows 30px per state, never shorter than 320px", () => {
    expect([STATE_HEATMAP_ROW_PX, STATE_HEATMAP_MIN_HEIGHT]).toEqual([30, 320]);
    expect(buildStateHeatmap(cells, ["TX"], "dropRate", T).height).toBe(320);
    const many = Array.from({ length: 40 }, (_, i) => `S${i}`);
    const r = buildStateHeatmap(grid([]), many, "dropRate", T);
    expect(r.height).toBe(40 * 30 + 70);
    expect(opt(r.options).chart.height).toBe(r.height);
  });

  it("has the hourly heatmap's settings (no toolbar, no labels, cell lines, redraw on resize)", () => {
    const o = opt(buildStateHeatmap(cells, ["TX"], "dropRate", T).options);
    expect(o.chart).toMatchObject({ type: "heatmap", redrawOnWindowResize: true, redrawOnParentResize: true, toolbar: { show: false } });
    expect(o.dataLabels.enabled).toBe(false);
    expect(o.legend.show).toBe(false);
    expect(o.stroke).toEqual({ width: 1, colors: ["#ffffff"] }); // white lines between cells on the light card, like the reference
    expect(o.xaxis.labels).toMatchObject({ rotate: 0, rotateAlways: false }); // level hour labels
  });

  it("the tooltip names the state and hour and shows all three numbers; nothing for an unknown cell", () => {
    const tip = opt(buildStateHeatmap(cells, ["TX", "CA", "NY"], "volume", T).options).tooltip.custom;
    const tx = tip({ seriesIndex: 2, dataPointIndex: 10 }) as string;
    expect(tx).toContain("Texas, 10:00 AM");
    expect(tx).toContain("Total Calls: 100");
    expect(tx).toContain("Consumed: 10 (10%)");
    expect(tx).toContain("Dropped: 90 (90%)");
    expect(tip({ seriesIndex: 9, dataPointIndex: 0 })).toBe("");
  });

  it("heatRanges is the shared scale maths", () => {
    expect(heatRanges([0, 0])[5].to).toBe(1);
    expect(heatRanges([0, 60])[5].to).toBe(60);
    expect(heatRanges([0, 60])[0].from).toBe(0);
  });
});

describe("heatmap in dark mode", () => {
  const cells = grid({ "1:10": [20, 10] });
  it("uses its own dark-to-teal scale and dark cell lines, so the grid doesn't glare on the dark card", () => {
    const light = opt(buildHeatmap(cells, "dropRate", LIGHT_CHART_THEME).options);
    const dark = opt(buildHeatmap(cells, "dropRate", DARK_CHART_THEME).options);
    expect(light.plotOptions.heatmap.colorScale.ranges.map((r: any) => r.color)).toEqual(HEATMAP_GREEN_SCALE);
    expect(dark.plotOptions.heatmap.colorScale.ranges.map((r: any) => r.color)).toEqual(HEATMAP_DARK_SCALE);
    expect(dark.stroke.colors).toEqual([DARK_CHART_THEME.cellStroke]);
    expect(DARK_CHART_THEME.cellStroke).not.toBe("#ffffff");
    // The lowest (empty) dark cell is genuinely dark: its brightness is well under the light scale's.
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    expect(lum(HEATMAP_DARK_SCALE[0])).toBeLessThan(lum(HEATMAP_GREEN_SCALE[0]) / 3);
    expect(lum(HEATMAP_DARK_SCALE[5])).toBeGreaterThan(lum(HEATMAP_DARK_SCALE[0]));
  });
  it("the State heatmap follows the same dark scale", () => {
    const sc = [{ state: "TX", state_name: "Texas", hour: 0, hour_label: "12:00 AM", total_calls: 1, consumed_calls: 0, dropped_calls: 1, consumption_pct: 0, drop_pct: 100 }];
    const o = opt(buildStateHeatmap(sc, ["TX"], "dropRate", DARK_CHART_THEME).options);
    expect(o.plotOptions.heatmap.colorScale.ranges.map((r: any) => r.color)).toEqual(HEATMAP_DARK_SCALE);
  });
});
