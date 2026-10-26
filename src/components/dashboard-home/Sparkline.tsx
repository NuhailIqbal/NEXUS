/**
 * The tiny trend under a headline number: one 2px line over a soft fade, no axes or grid, with a hover tooltip naming
 * the day and its value. A day with no figure (null) is a gap in the line, never a drop to zero. Purely decorative for
 * a screen reader: the number above it says everything (aria-hidden).
 */
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { dayLabel } from "@/lib/dashboardOverview";

export type SparkPoint = { date: string; value: number | null };

export function Sparkline({ points, color, format, id }: { points: SparkPoint[]; color: string; format: (v: number) => string; id: string }) {
  const gradient = `spark-${id}`;
  const data = points.map((p) => ({ label: dayLabel(p.date), value: p.value }));
  return (
    <div className="h-12 w-full min-w-0" aria-hidden="true" data-testid={`spark-${id}`} data-points={data.length}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 2 }}>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis hide domain={[0, "dataMax"]} />
          <Tooltip
            cursor={{ stroke: color, strokeOpacity: 0.4 }}
            contentStyle={{ background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, padding: "4px 8px" }}
            labelStyle={{ color: "hsl(var(--muted-foreground))" }}
            itemStyle={{ color: "hsl(var(--foreground))" }}
            formatter={(v: number | null) => [v === null || v === undefined ? "—" : format(v), ""]}
            separator=""
          />
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${gradient})`} connectNulls dot={false}
                activeDot={{ r: 4, stroke: "hsl(var(--card))", strokeWidth: 2 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
