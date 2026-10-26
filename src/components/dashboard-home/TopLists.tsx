/**
 * "Top campaigns / Top agents / Top inbound receptionists": three ranked tables for the chosen range, best first (most
 * qualified leads, then most calls). Each row has its calls, qualified leads and cost per qualified lead; a name links to
 * where it is managed. A table with nothing to rank says so in a sentence. Presentational: the ranking is done by
 * GET /dashboard/overview (services/dashboard_overview.py `tops`).
 */
import type { ComponentType } from "react";
import { Link } from "react-router-dom";
import { Bot, PhoneIncoming, Rocket } from "lucide-react";
import { SectionCard } from "@/components/call-consumption/SectionCard";
import { formatInt } from "@/lib/callConsumption";
import { ROUTES, type TopRow, type Tops } from "@/lib/dashboardOverview";
import { moneyOrDash } from "@/lib/leadRoi";

type Table = {
  key: keyof Tops;
  title: string;
  noun: string;
  icon: ComponentType<{ className?: string }>;
  to: string;
  empty: string;
};

const TABLES: Table[] = [
  { key: "campaigns", title: "Top campaigns", noun: "Campaign", icon: Rocket, to: ROUTES.campaigns, empty: "No campaign calls in this period." },
  { key: "agents", title: "Top agents", noun: "Agent", icon: Bot, to: ROUTES.agents, empty: "No agent has taken calls in this period." },
  { key: "receptionists", title: "Top inbound receptionists", noun: "Receptionist", icon: PhoneIncoming, to: ROUTES.receptionists, empty: "No inbound calls reached a receptionist in this period." },
];

function Ranking({ rows, noun, to, id }: { rows: TopRow[]; noun: string; to: string; id: string }) {
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[17rem] text-sm" data-testid={`top-${id}`}>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-8 px-1 pb-2 font-medium">#</th>
            <th scope="col" className="px-1 pb-2 font-medium">{noun}</th>
            <th scope="col" className="px-1 pb-2 text-right font-medium">Calls</th>
            <th scope="col" className="px-1 pb-2 text-right font-medium">Qualified</th>
            <th scope="col" className="px-1 pb-2 text-right font-medium" title="Spend divided by qualified leads">Cost / lead</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className="even:bg-muted/30">
              <td className="rounded-l-md px-1 py-2 tabular-nums text-muted-foreground">{i + 1}</td>
              <td className="max-w-[9rem] px-1 py-2">
                <Link to={to} className="block truncate font-medium text-foreground hover:underline" title={r.name}>{r.name}</Link>
              </td>
              <td className="px-1 py-2 text-right tabular-nums">{formatInt(r.calls)}</td>
              <td className="px-1 py-2 text-right font-semibold tabular-nums text-foreground">{formatInt(r.qualified_leads)}</td>
              <td className="rounded-r-md px-1 py-2 text-right tabular-nums text-muted-foreground">{moneyOrDash(r.cost_per_qualified_lead)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TopLists({ tops, loading }: { tops: Tops | null; loading: boolean }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3" data-testid="top-lists">
      {TABLES.map(({ key, title, noun, icon: Icon, to, empty }) => {
        const rows = tops?.[key] ?? [];
        return (
          <SectionCard
            key={key}
            className="rounded-2xl"
            title={title}
            subtitle="Most qualified leads first."
            loading={loading}
            empty={!!tops && rows.length === 0}
            emptyText={empty}
            minHeight={160}
            actions={<span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>}
          >
            {rows.length > 0 && <Ranking rows={rows} noun={noun} to={to} id={key} />}
          </SectionCard>
        );
      })}
    </div>
  );
}
