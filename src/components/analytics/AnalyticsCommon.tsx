import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
const analyticsTimeSeries = Array.from({ length: 14 }).map((_, i) => ({
  day: `D${i + 1}`,
  calls: 80 + ((i * 47) % 120),
  conversions: 20 + ((i * 23) % 60),
  duration: 60 + ((i * 31) % 120),
}));

export function StatGrid({ items }: { items: { label: string; value: string; delta?: string }[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((s) => (
        <div key={s.label} className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs uppercase text-muted-foreground">{s.label}</div>
          <div className="mt-1 text-2xl font-bold text-foreground">{s.value}</div>
          {s.delta && (
            <div className="mt-1 text-xs font-medium text-success">↑ {s.delta}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export function AnalyticsBar({ dataKey = "calls", title }: { dataKey?: string; title: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold text-foreground">{title}</h3>
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={analyticsTimeSeries}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 12,
                color: "hsl(var(--foreground))",
              }}
            />
            <Bar dataKey={dataKey} fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function AnalyticsLine({ title }: { title: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="font-semibold text-foreground">{title}</h3>
      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={analyticsTimeSeries}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 12,
                color: "hsl(var(--foreground))",
              }}
            />
            <Line type="monotone" dataKey="conversions" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} />
            <Line type="monotone" dataKey="calls" stroke="hsl(var(--info))" strokeWidth={2.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function DateRangeBar() {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
      <span className="text-sm text-muted-foreground">Date range:</span>
      <select className="h-9 rounded-md border border-input bg-background px-2 text-sm">
        <option>Last 14 days</option>
        <option>Last 30 days</option>
        <option>This quarter</option>
        <option>Custom…</option>
      </select>
      <select className="h-9 rounded-md border border-input bg-background px-2 text-sm">
        <option>All channels</option>
        <option>Voice</option>
        <option>WhatsApp</option>
      </select>
    </div>
  );
}
