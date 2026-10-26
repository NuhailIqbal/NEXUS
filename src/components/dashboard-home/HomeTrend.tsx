/**
 * The hero chart: calls (a filled area) and qualified leads (a line), hour by hour for a day or two and day by day for
 * longer, oldest first. The server sends every slot, zeros included, so the axis has no gaps; an hour that has not
 * happened yet is empty, so the line stops at the present instead of dropping to zero. A crosshair tooltip names both
 * series for the hovered slot; the legend is always shown (two series) and carries the period's totals. Colours are the
 * validated pair from useChartColors.
 */
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatInt } from "@/lib/callConsumption";
import type { ChartPoint } from "@/lib/dashboardOverview";
import { useChartColors } from "./useChartColors";

const tooltipStyle = {
  background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12, padding: "8px 10px",
  color: "hsl(var(--foreground))",
};

export function HomeTrend({ points }: { points: ChartPoint[] }) {
  const colors = useChartColors();
  const calls = points.reduce((n, p) => n + (p.calls ?? 0), 0);
  const qualified = points.reduce((n, p) => n + (p.qualified_leads ?? 0), 0);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2" data-testid="trend-legend">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-sm" style={{ background: colors.calls }} />
          <span className="text-sm text-muted-foreground">Calls</span>
          <span className="text-sm font-semibold text-foreground">{formatInt(calls)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-0.5 w-4 rounded" style={{ background: colors.qualified }} />
          <span className="text-sm text-muted-foreground">Qualified leads</span>
          <span className="text-sm font-semibold text-foreground">{formatInt(qualified)}</span>
        </div>
      </div>
      <div className="h-72 w-full min-w-0" data-testid="home-trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="home-calls-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.calls} stopOpacity={0.4} />
                <stop offset="100%" stopColor={colors.calls} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: "hsl(var(--muted-foreground))", strokeOpacity: 0.4 }}
                     labelFormatter={(_, payload) => payload?.[0]?.payload?.tip ?? ""} />
            <Area type="monotone" dataKey="calls" name="Calls" stroke={colors.calls} strokeWidth={2} fill="url(#home-calls-fill)"
                  dot={false} activeDot={{ r: 5, stroke: "hsl(var(--card))", strokeWidth: 2 }} />
            <Line type="monotone" dataKey="qualified_leads" name="Qualified leads" stroke={colors.qualified} strokeWidth={2.5}
                  dot={false} activeDot={{ r: 5, stroke: "hsl(var(--card))", strokeWidth: 2 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
