import { useState, useEffect } from "react";
const analyticsTimeSeries = Array.from({ length: 14 }).map((_, i) => ({
  day: `D${i + 1}`,
  calls: 80 + ((i * 47) % 120),
  conversions: 20 + ((i * 23) % 60),
  duration: 60 + ((i * 31) % 120),
}));
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { api } from "@/services/api";
import { Loader2 } from "lucide-react";

type OverviewStats = {
  total_calls: number;
  completed_calls: number;
  active_agents: number;
  total_campaigns: number;
  total_contacts: number;
  inbound_calls: number;
  outbound_calls: number;
};

type Props = { title: string; subtitle: string };

const AnalyticsChart = ({ title, subtitle }: Props) => {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await api.getAnalyticsOverview();
      if (data) setStats(data);
      setLoading(false);
    })();
  }, []);

  const statCards = stats
    ? [
        { label: "Total calls", value: stats.total_calls.toLocaleString() },
        { label: "Completed calls", value: stats.completed_calls.toLocaleString() },
        { label: "Active agents", value: stats.active_agents.toLocaleString() },
        { label: "Total campaigns", value: stats.total_campaigns.toLocaleString() },
      ]
    : [
        { label: "Total calls", value: "--" },
        { label: "Completed calls", value: "--" },
        { label: "Active agents", value: "--" },
        { label: "Total campaigns", value: "--" },
      ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-2xl font-bold text-foreground">
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : s.value}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <h3 className="mb-4 font-semibold text-foreground">Trends (last 14 days)</h3>
        <div className="h-72 w-full">
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
                  color: "hsl(var(--foreground))",
                }}
              />
              <Line type="monotone" dataKey="calls" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="conversions" stroke="hsl(var(--neon-cyan))" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="duration" stroke="hsl(var(--warning))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};

export const AnalyticsChannel = () => <AnalyticsChart title="Channel Analytics" subtitle="Performance per voice / SMS / WhatsApp / Web." />;
export const AnalyticsCampaign = () => <AnalyticsChart title="Campaign Analytics" subtitle="Compare campaigns side by side." />;
export const AnalyticsScenario = () => <AnalyticsChart title="Scenario Analytics" subtitle="Outcomes by scenario tag." />;
export const AnalyticsFlow = () => <AnalyticsChart title="Flow Statistics" subtitle="Drop-off and conversion per flow node." />;
