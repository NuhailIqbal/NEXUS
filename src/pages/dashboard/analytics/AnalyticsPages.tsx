import { useState, useEffect } from "react";
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Legend } from "recharts";
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

type SeriesPoint = {
  day: string;
  label: string;
  calls: number;
  completed: number;
  duration_min: number;
};

type AgentRow = { id: string; name: string; total_calls: number; completed: number; failed: number };
type CampaignRow = { id: string; name: string; contacts_count: number; completed_count: number; status: string };
type ChannelMap = Record<string, { total: number; completed: number; failed: number }>;

type Variant = "channel" | "campaign" | "scenario" | "flow";

type Props = { title: string; subtitle: string; variant: Variant };

const AnalyticsChart = ({ title, subtitle, variant }: Props) => {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [channels, setChannels] = useState<ChannelMap>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const calls: Promise<any>[] = [
        api.getAnalyticsOverview(),
        api.getAnalyticsTimeseries(14),
      ];
      if (variant === "campaign") calls.push(api.getAnalyticsCampaign());
      if (variant === "channel" || variant === "scenario" || variant === "flow") calls.push(api.getAnalyticsChannel());
      if (variant === "scenario" || variant === "flow") calls.push(api.getAnalyticsAgent());

      const results = await Promise.all(calls);
      if (results[0]?.data) setStats(results[0].data);
      if (Array.isArray(results[1]?.data)) setSeries(results[1].data);

      let idx = 2;
      if (variant === "campaign") {
        if (Array.isArray(results[idx]?.data)) setCampaigns(results[idx].data);
        idx++;
      }
      if (variant === "channel" || variant === "scenario" || variant === "flow") {
        if (results[idx]?.data && typeof results[idx].data === "object") setChannels(results[idx].data);
        idx++;
      }
      if (variant === "scenario" || variant === "flow") {
        if (Array.isArray(results[idx]?.data)) setAgents(results[idx].data);
      }
      setLoading(false);
    })();
  }, [variant]);

  const statCards = stats
    ? [
        { label: "Total calls",     value: stats.total_calls.toLocaleString() },
        { label: "Completed calls", value: stats.completed_calls.toLocaleString() },
        { label: "Active agents",   value: stats.active_agents.toLocaleString() },
        { label: "Total campaigns", value: stats.total_campaigns.toLocaleString() },
      ]
    : [
        { label: "Total calls", value: "--" },
        { label: "Completed calls", value: "--" },
        { label: "Active agents", value: "--" },
        { label: "Total campaigns", value: "--" },
      ];

  const totalCalls = series.reduce((s, p) => s + p.calls, 0);
  const hasData = totalCalls > 0;

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
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Trends (last 14 days)</h3>
          {!loading && !hasData && (
            <span className="text-xs text-muted-foreground">No call data yet chart will populate after your first calls.</span>
          )}
        </div>
        <div className="h-72 w-full">
          {loading ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : !hasData ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              <p>No conversations in the last 14 days.</p>
              <p className="text-xs">Run a campaign or take an inbound call to populate this chart.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 8,
                    color: "hsl(var(--foreground))",
                  }}
                />
                <Legend />
                <Line type="monotone" dataKey="calls"        name="Calls"            stroke="hsl(var(--primary))"    strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="completed"    name="Completed"        stroke="hsl(var(--neon-cyan))"  strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="duration_min" name="Duration (min)"   stroke="hsl(var(--warning))"    strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {variant === "channel" && <ChannelBreakdown channels={channels} />}
      {variant === "campaign" && <CampaignBreakdown campaigns={campaigns} />}
      {(variant === "scenario" || variant === "flow") && <AgentBreakdown agents={agents} />}
    </div>
  );
};

function ChannelBreakdown({ channels }: { channels: ChannelMap }) {
  const data = Object.entries(channels).map(([name, v]) => ({ name, ...v }));
  if (!data.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="mb-4 font-semibold text-foreground">By Channel</h3>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
            <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} />
            <Legend />
            <Bar dataKey="total"     name="Total"     fill="hsl(var(--primary))" />
            <Bar dataKey="completed" name="Completed" fill="hsl(var(--neon-cyan))" />
            <Bar dataKey="failed"    name="Failed"    fill="hsl(var(--destructive))" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CampaignBreakdown({ campaigns }: { campaigns: CampaignRow[] }) {
  if (!campaigns.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="mb-4 font-semibold text-foreground">Campaigns</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr><th className="py-2">Name</th><th>Status</th><th>Contacts</th><th>Completed</th><th>Progress</th></tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const pct = c.contacts_count > 0 ? Math.round((c.completed_count / c.contacts_count) * 100) : 0;
            return (
              <tr key={c.id} className="border-t border-border">
                <td className="py-2 font-medium">{c.name}</td>
                <td>{c.status}</td>
                <td>{c.contacts_count.toLocaleString()}</td>
                <td>{c.completed_count.toLocaleString()}</td>
                <td>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground">{pct}%</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AgentBreakdown({ agents }: { agents: AgentRow[] }) {
  if (!agents.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="mb-4 font-semibold text-foreground">By Agent</h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr><th className="py-2">Agent</th><th>Total</th><th>Completed</th><th>Failed</th></tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id} className="border-t border-border">
              <td className="py-2 font-medium">{a.name}</td>
              <td>{a.total_calls.toLocaleString()}</td>
              <td>{a.completed.toLocaleString()}</td>
              <td>{a.failed.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const AnalyticsChannel  = () => <AnalyticsChart variant="channel"  title="Channel Analytics"  subtitle="Performance per voice / SMS / WhatsApp / Web." />;
export const AnalyticsCampaign = () => <AnalyticsChart variant="campaign" title="Campaign Analytics" subtitle="Compare campaigns side by side." />;
export const AnalyticsScenario = () => <AnalyticsChart variant="scenario" title="Scenario Analytics" subtitle="Outcomes by agent and scenario." />;
export const AnalyticsFlow     = () => <AnalyticsChart variant="flow"     title="Flow Statistics"    subtitle="Drop-off and conversion per agent." />;
