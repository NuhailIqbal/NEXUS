/**
 * Overview's two "what should I look at" widgets: rule-based Insight cards, and the Worst/Best hotspots table.
 * Presentational: the backend decides what to say (services/call_consumption.py build_insights / build_hotspots);
 * this file only picks an icon and colour per category and lays the rows out.
 */
import { AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Clock, Info, type LucideIcon } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatInt } from "@/lib/callConsumption";
import { DropRatePill } from "./ConsumptionTable";

export type Insight = {
  category: string;
  badge: string;
  title: string;
  description: string;
  action_label: string | null;
  action: string | null;
};

export type Hotspot = {
  dimension: string;
  row_type: "Worst" | "Best";
  segment: string;
  segment_sub_label: string | null;
  calls: number;
  dropped: number;
  drop_rate_pct: number;
};

const CATEGORY_STYLE: Record<string, { box: string; Icon: LucideIcon }> = {
  "Worst Vertical": { box: "bg-destructive/10 text-destructive", Icon: AlertTriangle },
  "Worst State": { box: "bg-destructive/10 text-destructive", Icon: AlertTriangle },
  Anomaly: { box: "bg-warning/15 text-warning", Icon: Clock },
  Trend: { box: "bg-info/15 text-info", Icon: ArrowUp },
  Opportunity: { box: "bg-success/15 text-success", Icon: CheckCircle2 },
  "Peak Hour": { box: "bg-muted text-muted-foreground", Icon: Info },
  "Highest Volume": { box: "bg-muted text-muted-foreground", Icon: Info },
  Performance: { box: "bg-muted text-muted-foreground", Icon: Info },
};

function insightStyle(i: Pick<Insight, "category" | "badge">) {
  const base = CATEGORY_STYLE[i.category] ?? CATEGORY_STYLE.Performance;
  // A declining trend is the one Trend card that points down.
  return i.badge === "DECLINING" ? { ...base, Icon: ArrowDown } : base;
}

export function InsightsList({ insights }: { insights: Insight[] }) {
  return (
    <ul className="space-y-2">
      {insights.map((i, n) => {
        const { box, Icon } = insightStyle(i);
        return (
          <li key={`${i.badge}-${n}`} className="flex items-start gap-3 rounded-lg border border-border p-3">
            <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full", box)}>
              <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{i.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{i.description}</p>
              {i.action && (
                <p className="mt-1 text-xs text-foreground">
                  <span className="font-semibold">{i.action_label}:</span> {i.action}
                </p>
              )}
            </div>
            <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground">
              {i.badge}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function HotspotsTable({ rows }: { rows: Hotspot[] }) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[32rem]">
        <TableHeader>
          <TableRow>
            <TableHead>Dimension</TableHead>
            <TableHead>Segment</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Dropped</TableHead>
            <TableHead className="text-right">Drop rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.dimension}-${r.row_type}`}>
              <TableCell className="whitespace-nowrap">
                {r.dimension}{" "}
                <span className={cn("text-xs font-medium", r.row_type === "Worst" ? "text-destructive" : "text-success")}>
                  ({r.row_type})
                </span>
              </TableCell>
              <TableCell>
                {r.segment}
                {r.segment_sub_label && <span className="ml-2 text-xs text-muted-foreground">{r.segment_sub_label}</span>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.calls)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatInt(r.dropped)}</TableCell>
              <TableCell className="text-right"><DropRatePill value={r.drop_rate_pct} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
