/**
 * Charts for the Call Consumption pages, drawn with ApexCharts (react-apexcharts) from the configurations built in
 * lib/callConsumptionCharts.ts, which follow the Crystal chart spec. Each component only picks the theme, builds the
 * configuration (memoised: a new-but-equal object would make Apex redraw) and sizes its container:
 *
 *   ComboChart          fixed size + zoom/pan toolbar   (y-axes stay on screen while browsing hundreds of segments)
 *   DispositionStacked  grows its own width, card scrolls sideways
 *   RankingBars         grows its own height, card scrolls vertically
 *   HourlyHeatmap       7 x 24 grid on one shared colour scale; HourlyTrendChart 24 hours; DispositionDonut the mix
 */
import { useMemo } from "react";
import Chart from "react-apexcharts";
import { useTheme } from "next-themes";
import {
  DARK_CHART_THEME, LIGHT_CHART_THEME, buildCombo, buildDonut, buildHeatmap, buildHourlyTrend, buildRanking, buildStacked,
  buildStateHeatmap, type StateHeatCell,
  type ChartTheme, type ComboRow, type DispositionRow, type HeatCell, type HeatmapMetric, type MixRow, type RankingRow,
  type TrendPoint,
} from "@/lib/callConsumptionCharts";

export type { ComboRow, DispositionRow, HeatCell, MixRow, RankingRow, StateHeatCell, TrendPoint } from "@/lib/callConsumptionCharts";

/** The chart colours for the active light/dark mode (the dashboard defaults to dark). */
function useChartTheme(): ChartTheme {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "light" ? LIGHT_CHART_THEME : DARK_CHART_THEME;
}

/** Volume + drop rate for every segment. Fixed height; zoom/pan from Apex's own toolbar. */
export function ComboChart({ rows }: { rows: ComboRow[] }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildCombo(rows, theme), [rows, theme]);
  return <Chart type="area" series={spec.series} options={spec.options} height={350} width="100%" />;
}

/** Dropped calls per segment, one stacked series per reason. The chart is as wide as it needs; the card scrolls. */
export function DispositionStacked({ rows, keepOrder = false }: { rows: DispositionRow[]; keepOrder?: boolean }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildStacked(rows, theme, keepOrder), [rows, theme, keepOrder]);
  return (
    <div className="overflow-x-auto overflow-y-hidden" data-testid="stacked-scroll">
      {/* At least as wide as the card (so a few segments fill it), wider when there are many (then the card scrolls). */}
      <div style={{ minWidth: spec.width }}>
        <Chart type="bar" series={spec.series} options={spec.options} height={400} width="100%" />
      </div>
    </div>
  );
}

/** The overall mix of reasons calls were dropped. */
export function DispositionDonut({ rows }: { rows: MixRow[] }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildDonut(rows, theme), [rows, theme]);
  return <Chart type="donut" series={spec.series as number[]} options={spec.options} height={320} width="100%" />;
}

/** Every segment, worst drop rate first; clicking a campaign's label opens its reasons (`onSelect`). */
export function RankingBars({ rows, onSelect }: { rows: RankingRow[]; onSelect?: (row: RankingRow) => void }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildRanking(rows, theme, onSelect), [rows, theme, onSelect]);
  return (
    <div className="max-h-[520px] overflow-y-auto" data-testid="ranking-scroll">
      <Chart type="bar" series={spec.series} options={spec.options} height={spec.height} width="100%" />
    </div>
  );
}

/** Weekday x hour on one shared green scale. Scrolls sideways on narrow screens instead of squashing 24 columns. */
export function HourlyHeatmap({ cells, metric = "dropRate" }: { cells: HeatCell[]; metric?: HeatmapMetric }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildHeatmap(cells, metric, theme), [cells, metric, theme]);
  return (
    <div className="overflow-x-auto overflow-y-hidden">
      <div className="min-w-[44rem]">
        <Chart type="heatmap" series={spec.series} options={spec.options} height={320} width="100%" />
      </div>
    </div>
  );
}

/** States (rows, busiest on top) x hours of the day, the same look as the hourly heatmap. Grows with the states shown. */
export function StateHourHeatmap({ cells, states, metric = "dropRate" }: { cells: StateHeatCell[]; states: string[]; metric?: HeatmapMetric }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildStateHeatmap(cells, states, metric, theme), [cells, states, metric, theme]);
  return (
    <div className="overflow-x-auto overflow-y-hidden">
      <div className="min-w-[44rem]">
        <Chart type="heatmap" series={spec.series} options={spec.options} height={spec.height} width="100%" />
      </div>
    </div>
  );
}

/** Calls (columns) and drop rate (line) for each of the 24 hours. */
export function HourlyTrendChart({ points }: { points: TrendPoint[] }) {
  const theme = useChartTheme();
  const spec = useMemo(() => buildHourlyTrend(points, theme), [points, theme]);
  return <Chart type="line" series={spec.series} options={spec.options} height={350} width="100%" />;
}
