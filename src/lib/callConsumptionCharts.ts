/**
 * ApexCharts configurations for the Call Consumption pages. Every builder is a PURE function (data in, `{ series,
 * options }` out) so the exact configuration can be unit-tested without a browser; components/call-consumption/Charts.tsx
 * only hands the result to <Chart>. The settings follow the Crystal spec `call-consumption-chart-configs.md` chart by
 * chart (the numbers are the spec's: sizes, pixel-per-column constants, 0-100 pinned axes, colour scale), and each
 * non-obvious setting carries the spec's reason. Where NEXUS differs, the comment says so:
 *
 *   - rows are looked up by INDEX, not by segment name (two campaigns can share a name);
 *   - reasons keep the fixed BUCKET_COLORS / DROP_BUCKETS order instead of the spec's alphabetical open-ended
 *     disposition list + stateful palette (NEXUS has exactly six reasons, so a fixed colour is stable by construction);
 *   - "finished" calls are NEXUS's "consumed" calls and there is no revenue, so the combo tooltip shows consumed/dropped;
 *   - every builder takes a ChartTheme, because Apex needs concrete colours and the dashboard has a dark mode.
 */
import type { ApexOptions } from "apexcharts";
import {
  BUCKET_COLORS, BUCKET_LABELS, DROP_BUCKETS, formatInt, formatPct, truncateLabel, type DropBucket,
} from "@/lib/callConsumption";

// ------------------------------------------------------------------------------------------------ row types

export type ComboRow = { key: string; name: string; total_calls: number; consumed_calls: number; dropped_calls: number; drop_pct: number };
export type DispositionRow = { key: string; name: string; disposition: DropBucket; label: string; calls: number };
export type MixRow = { disposition: DropBucket; label: string; calls: number; pct_of_dropped: number };
export type RankingRow = { key: string; name: string; total_calls: number; dropped_calls: number; drop_rate_pct: number };
export type HeatCell = {
  day_of_week: number; day_label: string; hour: number; hour_label: string;
  total_calls: number; consumed_calls: number; dropped_calls: number; consumption_pct: number; drop_pct: number;
};
export type StateHeatCell = {
  state: string; state_name: string; hour: number; hour_label: string;
  total_calls: number; consumed_calls: number; dropped_calls: number; consumption_pct: number; drop_pct: number;
};
export type TrendPoint = { hour: number; hour_label: string; total_calls: number; dropped_calls: number; drop_pct: number };

export type ChartSpec = { series: ApexOptions["series"]; options: ApexOptions };

// ------------------------------------------------------------------------------------------------ colours + theme

/** Risk traffic light, reused across charts. */
export const RISK_COLORS = { danger: "#ff3366", warning: "#fbbc06", success: "#05a34a" } as const;

/** >= 50 danger, >= 30 warning, otherwise success. */
export function getRiskColor(pct: number): string {
  if (pct >= 50) return RISK_COLORS.danger;
  if (pct >= 30) return RISK_COLORS.warning;
  return RISK_COLORS.success;
}

/** Heatmap scale, light -> dark green, 6 steps. */
export const HEATMAP_GREEN_SCALE = ["#d2f0e5", "#b7ecd9", "#7cfdd3", "#3ecfa0", "#0f8b72", "#0b5c4b"];
/** Dark-mode scale: the pale end of the light scale would glare on the near-black card, so this one starts dark (few or
 * no calls) and brightens toward teal (many), keeping "more = more visible". */
export const HEATMAP_DARK_SCALE = ["#17251f", "#1e3a30", "#255043", "#2d6d58", "#3b9177", "#58b898"];

/** Hour labels stay level ("12:00 AM") like the reference; when they don't all fit, Apex hides some instead of tilting. */
const LEVEL_HOUR_LABELS = { rotate: 0, rotateAlways: false, hideOverlappingLabels: true } as const;

/** Accent green for the volume series and clickable axis labels. */
export const ACCENT = "#448f7b";

/** The colour pair the spec uses for the drop-rate line against the volume bars. */
const DROP_LINE_PINK = "#e0507a";

/**
 * Colours that depend on light/dark mode. Apex draws SVG with literal colours (it cannot read CSS variables), so the
 * component picks LIGHT_ or DARK_CHART_THEME from the active theme (the values are the brand palette's --card and
 * --muted-foreground, which are fixed per mode) and passes it in.
 */
export type ChartTheme = {
  mode: "light" | "dark";
  /** Axis labels, legends, titles. */
  foreColor: string;
  /** Grid lines. */
  gridColor: string;
  /** Between-cell lines on the heatmap (the card colour: white on the light card, as in the reference). */
  cellStroke: string;
  /** Heatmap colour scale for this mode, low -> high. */
  heatScale: string[];
  /** Link-style y-axis labels that aren't clickable. */
  mutedLabel: string;
};

export const LIGHT_CHART_THEME: ChartTheme = {
  mode: "light", foreColor: "#373d3f", gridColor: "#e0e6e3", cellStroke: "#ffffff", heatScale: HEATMAP_GREEN_SCALE, mutedLabel: "#373d3f",
};
export const DARK_CHART_THEME: ChartTheme = {
  mode: "dark", foreColor: "#adadad", gridColor: "#2a2f2d", cellStroke: "#0f0f0f", heatScale: HEATMAP_DARK_SCALE, mutedLabel: "#adadad",
};

// ------------------------------------------------------------------------------------------------ shared pieces

const NO_DATA = { text: "No Data Found", align: "center", verticalAlign: "middle" } as const;

/** Apex tooltips follow `tooltip.theme`; mode picks the light or dark card. */
const tooltipTheme = (t: ChartTheme) => t.mode;

/** The app's own font, named explicitly: Apex measures label widths with it, and "inherit" made it under-measure
 * (and clip) labels drawn in Inter. */
const FONT = "Inter, ui-sans-serif, system-ui, sans-serif";
const baseChart = (t: ChartTheme) => ({ foreColor: t.foreColor, fontFamily: FONT, background: "transparent" });
const baseGrid = (t: ChartTheme) => ({ borderColor: t.gridColor });

/** Axis tick: thousands separators, and fractional ticks (Apex makes 0.5 steps for tiny counts) stay honest instead of rounding into duplicates. */
export const tickInt = (v: number) => (Number.isInteger(v) ? formatInt(v) : v.toLocaleString(undefined, { maximumFractionDigits: 1 }));

/** HTML-escape text that goes into a custom tooltip (segment names come from user data). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ------------------------------------------------------------------------------------------------ 1. hourly heatmap

export type HeatmapMetric = "dropRate" | "consumption" | "volume";

export const HEATMAP_METRICS: { value: HeatmapMetric; label: string }[] = [
  { value: "dropRate", label: "Drop rate" },
  { value: "consumption", label: "Consumption rate" },
  { value: "volume", label: "Call volume" },
];

type MetricCell = Pick<HeatCell, "consumption_pct" | "total_calls" | "drop_pct">;

export function heatmapMetricValue(cell: MetricCell, metric: HeatmapMetric): number {
  switch (metric) {
    case "consumption": return cell.consumption_pct;
    case "volume": return cell.total_calls;
    default: return cell.drop_pct;
  }
}

/**
 * 7 series (one per day) of 24 points. Apex draws the first series at the BOTTOM, so ascending day order puts Sunday
 * at the bottom and Saturday on top. The colour scale is explicit, with buckets derived from the grid's own min/max and
 * SHARED by every cell: Apex heatmaps ignore per-cell colours, and its automatic per-series shading would scale each
 * weekday on its own (Monday's worst cell would look like Friday's worst at very different values).
 */
/**
 * The explicit 6-step colour scale shared by every cell of a heatmap, from 0 to the grid's own maximum. Anchored at 0,
 * and `|| 1` stops a divide-by-zero step when every value is identical or zero.
 */
export function heatRanges(values: number[], scale: string[] = HEATMAP_GREEN_SCALE) {
  const minVal = Math.min(0, ...values);
  const maxVal = Math.max(0, ...values) || 1;
  const step = (maxVal - minVal) / scale.length || 1;
  return scale.map((color, i) => ({
    from: minVal + i * step,
    to: i === scale.length - 1 ? maxVal : minVal + (i + 1) * step,
    color,
    name: "",
  }));
}

export function buildHeatmap(cells: HeatCell[], metric: HeatmapMetric, theme: ChartTheme): ChartSpec {
  // Day and hour labels come from the API cells so the two can never drift apart.
  const dayIndexes = Array.from(new Set(cells.map((c) => c.day_of_week))).sort((a, b) => a - b);
  const byDayHour = new Map(cells.map((c) => [`${c.day_of_week}:${c.hour}`, c]));

  const series = dayIndexes.map((day) => {
    const dayCells = cells.filter((c) => c.day_of_week === day).sort((a, b) => a.hour - b.hour);
    return {
      name: dayCells[0]?.day_label ?? "",
      data: dayCells.map((c) => ({ x: c.hour_label, y: heatmapMetricValue(c, metric) })),
    };
  });

  const ranges = heatRanges(cells.map((c) => heatmapMetricValue(c, metric)), theme.heatScale);

  return {
    series,
    options: {
      chart: {
        ...baseChart(theme),
        height: 320,
        type: "heatmap",
        toolbar: { show: false },
        // The chart lives in a card that can open late; without these it renders at zero width.
        redrawOnWindowResize: true,
        redrawOnParentResize: true,
        animations: { enabled: false },
      },
      dataLabels: { enabled: false }, // 168 cells: numbers in every cell are unreadable
      legend: { show: false },
      plotOptions: { heatmap: { radius: 2, colorScale: { ranges } } },
      stroke: { width: 1, colors: [theme.cellStroke] }, // separates adjacent cells
      xaxis: { type: "category", labels: LEVEL_HOUR_LABELS },
      tooltip: {
        theme: tooltipTheme(theme),
        // Shows all three metrics whichever one is plotted.
        custom: ({ seriesIndex, dataPointIndex }: { seriesIndex: number; dataPointIndex: number }) => {
          const cell = byDayHour.get(`${dayIndexes[seriesIndex]}:${dataPointIndex}`);
          if (!cell) return "";
          return `<div style="padding:8px 12px;font-size:13px;">
            <div><b>${escapeHtml(cell.day_label)} ${escapeHtml(cell.hour_label)}</b></div>
            <div>Total Calls: ${formatInt(cell.total_calls)}</div>
            <div>Consumed: ${formatInt(cell.consumed_calls)} (${cell.consumption_pct}%)</div>
            <div>Dropped: ${formatInt(cell.dropped_calls)} (${cell.drop_pct}%)</div>
          </div>`;
        },
      },
      noData: NO_DATA,
    },
  };
}

// ------------------------------------------------------------------------------------------------ state x hour heatmap

export const STATE_HEATMAP_ROW_PX = 30;
export const STATE_HEATMAP_MIN_HEIGHT = 320;

/**
 * State x hour-of-day, the same look as the hourly heatmap: one row per state in `states` (busiest first, so it is drawn
 * at the TOP: Apex draws the first series at the bottom, hence the reverse), 24 hour columns, one shared colour scale
 * over the cells shown. The chart grows 30px per state (min 320) so rows never get squashed.
 */
export function buildStateHeatmap(
  cells: StateHeatCell[], states: string[], metric: HeatmapMetric, theme: ChartTheme,
): ChartSpec & { height: number } {
  const byKey = new Map(cells.map((c) => [`${c.state}:${c.hour}`, c]));
  const bottomUp = [...states].reverse();
  const series = bottomUp.map((state) => {
    const row = cells.filter((c) => c.state === state).sort((a, b) => a.hour - b.hour);
    return { name: row[0]?.state_name ?? state, data: row.map((c) => ({ x: c.hour_label, y: heatmapMetricValue(c, metric) })) };
  });
  const shown = cells.filter((c) => states.includes(c.state));
  const height = Math.max(STATE_HEATMAP_MIN_HEIGHT, states.length * STATE_HEATMAP_ROW_PX + 70);

  return {
    height,
    series,
    options: {
      chart: {
        ...baseChart(theme),
        height,
        type: "heatmap",
        toolbar: { show: false },
        redrawOnWindowResize: true,
        redrawOnParentResize: true,
        animations: { enabled: false },
      },
      dataLabels: { enabled: false },
      legend: { show: false },
      plotOptions: { heatmap: { radius: 2, colorScale: { ranges: heatRanges(shown.map((c) => heatmapMetricValue(c, metric)), theme.heatScale) } } },
      stroke: { width: 1, colors: [theme.cellStroke] },
      xaxis: { type: "category", labels: LEVEL_HOUR_LABELS },
      tooltip: {
        theme: tooltipTheme(theme),
        custom: ({ seriesIndex, dataPointIndex }: { seriesIndex: number; dataPointIndex: number }) => {
          const cell = byKey.get(`${bottomUp[seriesIndex]}:${dataPointIndex}`);
          if (!cell) return "";
          return `<div style="padding:8px 12px;font-size:13px;">
            <div><b>${escapeHtml(cell.state_name)}, ${escapeHtml(cell.hour_label)}</b></div>
            <div>Total Calls: ${formatInt(cell.total_calls)}</div>
            <div>Consumed: ${formatInt(cell.consumed_calls)} (${cell.consumption_pct}%)</div>
            <div>Dropped: ${formatInt(cell.dropped_calls)} (${cell.drop_pct}%)</div>
          </div>`;
        },
      },
      noData: NO_DATA,
    },
  };
}

// ------------------------------------------------------------------------------------------------ 2. hourly trend

/**
 * Columns = total calls, line = drop rate. The rate axis is pinned 0-100 so the slope means the same thing on every
 * refilter (an auto-scaled axis makes 2% -> 3% look like a crisis). `shared` tooltip: volume and rate for one hour in
 * one hover. 24 points, so no zoom.
 */
export function buildHourlyTrend(points: TrendPoint[], theme: ChartTheme): ChartSpec {
  const sorted = (points ?? []).slice().sort((a, b) => a.hour - b.hour);
  return {
    series: [
      { name: "Total calls", type: "column", data: sorted.map((p) => p.total_calls) },
      { name: "Drop rate %", type: "line", data: sorted.map((p) => p.drop_pct) },
    ],
    options: {
      chart: {
        ...baseChart(theme),
        height: 350,
        type: "line",
        toolbar: { show: false },
        redrawOnWindowResize: true,
        redrawOnParentResize: true,
      },
      stroke: { width: [0, 3], curve: "smooth" }, // no stroke on bars, 3px on the line
      colors: [ACCENT, DROP_LINE_PINK],
      plotOptions: { bar: { columnWidth: "60%", borderRadius: 3 } },
      fill: { opacity: [1, 0.15] },
      grid: baseGrid(theme),
      xaxis: { categories: sorted.map((p) => p.hour_label) },
      yaxis: [
        { title: { text: "Total calls" }, labels: { formatter: (v: number) => tickInt(v) } },
        { opposite: true, title: { text: "Drop rate %" }, min: 0, max: 100 },
      ],
      legend: { position: "top" },
      tooltip: { theme: tooltipTheme(theme), shared: true },
      noData: NO_DATA,
    },
  };
}

// ------------------------------------------------------------------------------------------------ 4. volume + drop-rate combo

/**
 * Every segment (can be hundreds). Fixed size (zoom/pan and the toolbar are switched off). The drop-rate "area" has no fill (a bare line never hides the bars), and tick labels may
 * hide when they overlap (Apex default) rather than all being forced to render.
 */
export function buildCombo(rows: ComboRow[], theme: ChartTheme): ChartSpec {
  const categories = rows.map((r) => r.name);
  return {
    series: [
      { name: "Drop Rate %", type: "area", data: rows.map((r) => Number((r.drop_pct ?? 0).toFixed(2))) },
      { name: "Dropped Calls", type: "column", data: rows.map((r) => r.dropped_calls) },
    ],
    options: {
      chart: {
        ...baseChart(theme),
        height: 350,
        type: "area",
        stacked: false,
        zoom: { enabled: false },
        toolbar: { show: false }, // no zoom/pan/menu icons
      },
      colors: [RISK_COLORS.danger, ACCENT],
      fill: { type: ["solid", "solid"], opacity: [0, 0.85] }, // area transparent (line only), bars solid (not Apex's default gradient)
      stroke: { show: true, curve: "smooth", width: [3, 0] },
      markers: { size: [4, 0], strokeWidth: 0, hover: { size: 6 } },
      dataLabels: { enabled: false },
      grid: baseGrid(theme),
      legend: { show: true, position: "top", horizontalAlign: "center" },
      xaxis: {
        categories,
        labels: {
          rotate: -45,
          // Only the RENDERED tick text is truncated: `categories` keeps the full name for tooltips.
          formatter: (value: string) => truncateLabel(String(value)),
          style: { fontSize: "11px" },
        },
      },
      yaxis: [
        {
          seriesName: "Drop Rate %", opposite: true, min: 0, max: 100, title: { text: "Drop Rate %" },
          labels: { formatter: (v: number) => `${v}%` },
        },
        {
          seriesName: "Dropped Calls", title: { text: "Dropped Calls" },
          labels: { formatter: (v: number) => tickInt(v) },
        },
      ],
      tooltip: {
        theme: tooltipTheme(theme),
        shared: true,
        intersect: false,
        // Index lookup: O(1) per hover, and correct when two segments share a name.
        custom: ({ dataPointIndex }: { dataPointIndex: number }) => {
          const row = rows[dataPointIndex];
          if (!row) return "";
          return `<div style="padding:8px 12px;font-size:13px;">
            <strong>${escapeHtml(row.name)}</strong><br>
            Total Calls: <strong>${formatInt(row.total_calls)}</strong><br>
            Consumed Calls: <strong>${formatInt(row.consumed_calls)}</strong><br>
            Dropped Calls: <strong>${formatInt(row.dropped_calls)}</strong><br>
            Drop Rate: <strong>${(row.drop_pct ?? 0).toFixed(1)}%</strong>
          </div>`;
        },
      },
      noData: NO_DATA,
    },
  };
}

// ------------------------------------------------------------------------------------------------ 5. disposition stacked bar

export const PX_PER_CAMPAIGN = 45;
export const STACKED_MIN_WIDTH = 700;

/**
 * Opposite strategy to the combo: the chart GROWS its own width (45px per segment, min 700) and the card scrolls
 * sideways, because this chart has no axis worth freezing. Counts are gathered in one pass into a lookup (a
 * rows.find() per cell over hundreds of segments froze the page in the original). Because the chart is far wider
 * than the viewport `tooltip.fixed` would draw off-screen, so it uses `followCursor`; `x.formatter` restores the full
 * name in the tooltip title (otherwise it falls back to the truncated tick text).
 */
/** `keepOrder`: leave the segments in the order they arrive (a timeline) instead of busiest first. */
export function buildStacked(rows: DispositionRow[], theme: ChartTheme, keepOrder = false): ChartSpec & { width: number } {
  const totals = new Map<string, { name: string; total: number }>();
  const counts = new Map<string, Map<DropBucket, number>>();
  for (const r of rows) {
    const t = totals.get(r.key) ?? { name: r.name, total: 0 };
    t.total += r.calls;
    totals.set(r.key, t);
    const c = counts.get(r.key) ?? new Map<DropBucket, number>();
    c.set(r.disposition, (c.get(r.disposition) ?? 0) + r.calls);
    counts.set(r.key, c);
  }
  // Busiest first.
  const ordered = Array.from(totals.entries());
  if (!keepOrder) ordered.sort((a, b) => b[1].total - a[1].total);
  const segments = ordered.map(([key, v]) => ({ key, name: v.name }));
  const used = DROP_BUCKETS.filter((b) => rows.some((r) => r.disposition === b));
  const width = Math.max(STACKED_MIN_WIDTH, segments.length * PX_PER_CAMPAIGN);

  return {
    width,
    series: used.map((b) => ({ name: BUCKET_LABELS[b], data: segments.map((s) => counts.get(s.key)?.get(b) ?? 0) })),
    options: {
      chart: { ...baseChart(theme), type: "bar", height: 400, stacked: true, toolbar: { show: false } },
      plotOptions: { bar: { horizontal: false, columnWidth: "70%" } },
      colors: used.map((b) => BUCKET_COLORS[b]),
      grid: baseGrid(theme),
      xaxis: {
        categories: segments.map((s) => s.name),
        labels: {
          rotate: -45,
          hideOverlappingLabels: false, // the chart is wide enough; show them all
          formatter: (value: string) => truncateLabel(String(value)),
          style: { fontSize: "11px" },
        },
      },
      yaxis: { labels: { formatter: (v: number) => tickInt(v) } },
      legend: { position: "bottom" },
      dataLabels: { enabled: false },
      tooltip: { theme: tooltipTheme(theme), shared: true, intersect: false, followCursor: true, x: { formatter: (value: number | string) => String(value) } },
      noData: NO_DATA,
    },
  };
}

// ------------------------------------------------------------------------------------------------ 6. disposition donut

/**
 * Counts live in the LEGEND, not on the slices (thin slices can't hold a label), and `showAlways` keeps the centre
 * total visible when nothing is hovered.
 */
export function buildDonut(rows: MixRow[], theme: ChartTheme): ChartSpec {
  return {
    series: rows.map((r) => r.calls),
    options: {
      labels: rows.map((r) => r.label),
      colors: rows.map((r) => BUCKET_COLORS[r.disposition]),
      chart: { ...baseChart(theme), type: "donut", height: 320 },
      stroke: { colors: [theme.cellStroke] },
      plotOptions: {
        pie: {
          donut: {
            size: "65%",
            labels: {
              show: true,
              value: { show: true, color: theme.foreColor, formatter: (val: string) => Number(val).toLocaleString("en-US") },
              total: {
                show: true,
                showAlways: true,
                label: "TOTAL",
                color: theme.foreColor,
                formatter: (w: { globals: { seriesTotals: number[] } }) =>
                  w.globals.seriesTotals.reduce((a, b) => a + b, 0).toLocaleString(),
              },
            },
          },
        },
      },
      legend: {
        position: "right",
        horizontalAlign: "center",
        formatter: (seriesName: string, opts: { w: { globals: { series: number[] } }; seriesIndex: number }) =>
          `${seriesName}: ${opts.w.globals.series[opts.seriesIndex].toLocaleString()}`,
      },
      dataLabels: { enabled: false },
      tooltip: { theme: tooltipTheme(theme), y: { formatter: (val: number) => val.toLocaleString("en-US") } },
      noData: NO_DATA,
    },
  };
}

// ------------------------------------------------------------------------------------------------ 7. drop-rate ranking

/** Third sizing strategy: DYNAMIC HEIGHT (28px per bar, min 350) inside a vertically scrolling container. */
export const PX_PER_BAR = 28;
export const RANKING_MIN_HEIGHT = 350;
/** A segment must have at least this drop rate to be a drill-down link. */
export const HYPERLINK_MIN_DROP_RATE = 0;

/** Whether a ranking row can open the reasons page: it must have a campaign id and some drops. */
export function isDrillable(row: RankingRow | undefined): row is RankingRow {
  return !!row && !!row.key && (row.drop_rate_pct ?? 0) > HYPERLINK_MIN_DROP_RATE;
}

/**
 * Horizontal bars, worst -> best, each in its risk colour. `distributed` is what allows a colour per bar (and also
 * emits one legend entry per bar, hence `legend.show: false`). On a horizontal Apex bar the VALUE axis is `xaxis` and
 * the CATEGORY axis is `yaxis`, so the formatters look swapped but are right. Data labels sit on a small background box
 * because a 0% bar is zero-length and its label would otherwise land on the plain chart background. Clickable segments'
 * labels are tinted like links; `onDrill` is called with the row when one is clicked.
 */
export function buildRanking(rows: RankingRow[], theme: ChartTheme, onDrill?: (row: RankingRow) => void): ChartSpec & { height: number } {
  const categories = rows.map((r) => r.name);
  const dropRates = rows.map((r) => Number((r.drop_rate_pct ?? 0).toFixed(2)));
  const height = Math.max(RANKING_MIN_HEIGHT, categories.length * PX_PER_BAR);
  const click = (index: number | undefined) => {
    const row = index === undefined ? undefined : rows[index];
    if (onDrill && isDrillable(row)) onDrill(row);
  };

  return {
    height,
    series: [{ name: "Drop Rate %", data: dropRates }],
    options: {
      chart: {
        ...baseChart(theme),
        type: "bar",
        height,
        toolbar: { show: false },
        events: {
          // The category labels act as drill-down links (the spec's xAxisLabelClick); clicking a bar does the same.
          xAxisLabelClick: (_e: unknown, _c: unknown, config: { labelIndex?: number }) => click(config?.labelIndex),
          dataPointSelection: (_e: unknown, _c: unknown, config: { dataPointIndex?: number }) => click(config?.dataPointIndex),
        },
      },
      plotOptions: { bar: { horizontal: true, distributed: true, barHeight: "80%" } },
      colors: dropRates.map(getRiskColor),
      grid: baseGrid(theme),
      xaxis: { categories, labels: { formatter: (v: string) => `${v}%` }, min: 0, max: 100 },
      yaxis: {
        labels: {
          maxWidth: 200,
          style: {
            fontSize: "12px",
            colors: rows.map((r) => (isDrillable(r) ? ACCENT : theme.mutedLabel)),
          },
          formatter: (v: string | number) => truncateLabel(String(v)),
        },
      },
      legend: { show: false },
      dataLabels: {
        enabled: true,
        style: { fontSize: "11px", colors: ["#000"] },
        background: { enabled: true, foreColor: "#fff", borderRadius: 2, padding: 4, opacity: 0.9, borderWidth: 0 },
        formatter: (val: number) => `${val.toFixed(1)}%`,
      },
      tooltip: { theme: tooltipTheme(theme), y: { formatter: (val: number) => `${val.toFixed(1)}%` } },
      noData: NO_DATA,
    },
  };
}

/** Kept here so callers format a rate the same way the chart does. */
export const chartPct = (n: number) => formatPct(n, 1);
