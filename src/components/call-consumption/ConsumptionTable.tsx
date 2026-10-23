/**
 * The Call Consumption summary table: Name | Total | Consumed | Consumption rate | Dropped | Drop rate | one column
 * per drop reason. Rows may carry `children` (Overview's month > week > day tree): a chevron expands them, and
 * `defaultExpandDepth` says how many levels start open. The Total row is the one the server sent (the same figures
 * the CSV export uses), never summed again here. The first column stays pinned while the rest scrolls sideways.
 *
 * `onRowClick` makes top-level rows clickable (the Campaign page uses it for the drill-down); `emptyText` shows
 * instead of the table when there are no rows.
 */
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  BUCKET_COLORS, BUCKET_LABELS, DROP_BUCKETS, dropRateColor, dropRateTint, formatDelta, formatInt, formatPct, trendColorClass, type TreeRow,
} from "@/lib/callConsumption";

function collectKeys(rows: TreeRow[], depth: number, limit: number, path = ""): string[] {
  return rows.flatMap((r, i) => {
    const key = `${path}/${i}:${r.name}`;
    return depth < limit && r.children?.length ? [key, ...collectKeys(r.children, depth + 1, limit, key)] : [];
  });
}

export function DropRatePill({ value }: { value: number }) {
  return (
    <span
      className="inline-block min-w-[3.5rem] rounded-md px-2 py-0.5 text-center text-xs font-semibold"
      style={{ backgroundColor: dropRateTint(value), color: dropRateColor(value) }}
      data-testid="drop-rate"
    >
      {formatPct(value, 2)}
    </span>
  );
}

/** A signed change coloured by whether it is good news ("—" when there is nothing to compare with). */
function Change({ value, unit, higherIsBetter }: { value: number | null | undefined; unit: string; higherIsBetter: boolean }) {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  return <span className={cn("tabular-nums", trendColorClass(value, higherIsBetter))}>{formatDelta(value)}{unit}</span>;
}

export function ConsumptionTable({
  rows,
  total,
  firstColumn = "Name",
  defaultExpandDepth = 0,
  onRowClick,
  showChange = false,
  emptyText = "No Data Found",
}: {
  rows: TreeRow[];
  total?: TreeRow | null;
  firstColumn?: string;
  defaultExpandDepth?: number;
  onRowClick?: (row: TreeRow) => void;
  /** Weekly / monthly: add "Calls vs previous" and "Drop rate vs previous" columns (rows carry the figures). */
  showChange?: boolean;
  emptyText?: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(collectKeys(rows, 0, defaultExpandDepth)));

  if (!rows.length) {
    return <div className="flex min-h-[96px] items-center justify-center text-sm text-muted-foreground">{emptyText}</div>;
  }

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const cells = (r: TreeRow) => (
    <>
      <TableCell className="text-right tabular-nums">{formatInt(r.total_calls)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(r.consumed_calls)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatPct(r.consumption_pct, 2)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(r.dropped_calls)}</TableCell>
      <TableCell className="text-right"><DropRatePill value={r.drop_pct} /></TableCell>
      {DROP_BUCKETS.map((b) => (
        <TableCell key={b} className="text-right tabular-nums text-muted-foreground">{formatInt(r.buckets[b])}</TableCell>
      ))}
      {showChange && (
        <>
          <TableCell className="text-right"><Change value={r.calls_change_pct} unit="%" higherIsBetter /></TableCell>
          <TableCell className="text-right"><Change value={r.drop_pct_point_change} unit=" pts" higherIsBetter={false} /></TableCell>
        </>
      )}
    </>
  );

  const render = (nodes: TreeRow[], depth: number, path: string): React.ReactNode =>
    nodes.map((r, i) => {
      const key = `${path}/${i}:${r.name}`;
      const hasKids = !!r.children?.length;
      const open = expanded.has(key);
      const clickable = depth === 0 && !!onRowClick;
      return (
        <Fragment key={key}>
          <TableRow
            className={cn(depth === 0 && "font-medium", clickable && "cursor-pointer")}
            onClick={clickable ? () => onRowClick!(r) : undefined}
          >
            <TableCell className="sticky left-0 z-[1] bg-card" style={{ paddingLeft: 12 + depth * 18 }}>
              <div className="flex items-center gap-1">
                {hasKids ? (
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-accent"
                    aria-label={`${open ? "Collapse" : "Expand"} ${r.name}`}
                    aria-expanded={open}
                    onClick={(e) => { e.stopPropagation(); toggle(key); }}
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                ) : (
                  <span className="inline-block w-5" />
                )}
                <span className={cn("whitespace-nowrap", clickable && "text-primary hover:underline")}>{r.name}</span>
                {r.partial && <span className="ml-2 whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground">partial</span>}
              </div>
            </TableCell>
            {cells(r)}
          </TableRow>
          {hasKids && open && render(r.children!, depth + 1, key)}
        </Fragment>
      );
    });

  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[56rem]">
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-[1] bg-card">{firstColumn}</TableHead>
            <TableHead className="text-right">Total calls</TableHead>
            <TableHead className="text-right">Consumed</TableHead>
            <TableHead className="text-right">Consumption rate</TableHead>
            <TableHead className="text-right">Dropped</TableHead>
            <TableHead className="text-right">Drop rate</TableHead>
            {DROP_BUCKETS.map((b) => (
              <TableHead key={b} className="whitespace-nowrap text-right">
                <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ backgroundColor: BUCKET_COLORS[b] }} />
                {BUCKET_LABELS[b]}
              </TableHead>
            ))}
            {showChange && (
              <>
                <TableHead className="whitespace-nowrap text-right">Calls vs previous</TableHead>
                <TableHead className="whitespace-nowrap text-right">Drop rate vs previous</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {render(rows, 0, "")}
          {total && (
            <TableRow className="border-t-2 font-semibold hover:bg-transparent" data-testid="total-row">
              <TableCell className="sticky left-0 z-[1] bg-card">Total</TableCell>
              {cells(total)}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
