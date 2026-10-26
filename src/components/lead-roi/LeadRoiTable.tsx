/**
 * The Cost per lead & ROI table, one row per campaign or per week / month plus the Total the server sent (the same
 * figures the CSV uses, never summed again here). A figure the server could not work out (no leads, no value set, nothing
 * spent) is shown as "—", never as $0. Revenue, profit and ROI are only shown once the account has set what a lead is
 * worth (`showValue`). The first column stays pinned while the rest scrolls sideways.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatInt } from "@/lib/callConsumption";
import { moneyOrDash, roiOrDash, type LeadRoiRow } from "@/lib/leadRoi";

type Row = LeadRoiRow & { name: string; partial?: boolean; value_source?: "campaign" | "account" | null };

/** Green for a profit, red for a loss, plain for "not available". */
const signClass = (n: number | null) => (n === null ? "text-muted-foreground" : n >= 0 ? "text-success" : "text-destructive");

export function LeadRoiTable({
  rows, total, firstColumn, showValue, emptyText = "No Data Found",
}: {
  rows: Row[];
  total: Row;
  firstColumn: string;
  showValue: boolean;
  emptyText?: string;
}) {
  if (!rows.length) {
    return <div className="flex min-h-[96px] items-center justify-center text-sm text-muted-foreground">{emptyText}</div>;
  }
  const cells = (r: Row) => (
    <>
      <TableCell className="text-right tabular-nums">{formatInt(r.calls)}</TableCell>
      <TableCell className="text-right tabular-nums">{moneyOrDash(r.spend)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(r.leads)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatInt(r.qualified_leads)}</TableCell>
      <TableCell className="text-right tabular-nums">{moneyOrDash(r.cost_per_lead)}</TableCell>
      <TableCell className="text-right tabular-nums">{moneyOrDash(r.cost_per_qualified_lead)}</TableCell>
      {showValue && (
        <>
          <TableCell className="text-right tabular-nums">{moneyOrDash(r.revenue)}</TableCell>
          <TableCell className={cn("text-right tabular-nums", signClass(r.profit))}>{moneyOrDash(r.profit)}</TableCell>
          <TableCell className={cn("text-right font-medium tabular-nums", signClass(r.roi_pct))}>{roiOrDash(r.roi_pct)}</TableCell>
        </>
      )}
    </>
  );
  return (
    <div className="overflow-x-auto">
      <Table className={showValue ? "min-w-[60rem]" : "min-w-[44rem]"}>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-[1] bg-card">{firstColumn}</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Leads</TableHead>
            <TableHead className="whitespace-nowrap text-right">Qualified leads</TableHead>
            <TableHead className="whitespace-nowrap text-right">Cost per lead</TableHead>
            <TableHead className="whitespace-nowrap text-right">Cost per qualified lead</TableHead>
            {showValue && (
              <>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="text-right">ROI</TableHead>
              </>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, i) => (
            <TableRow key={`${i}:${r.name}`} className="font-medium">
              <TableCell className="sticky left-0 z-[1] bg-card">
                <span className="whitespace-nowrap">{r.name}</span>
                {r.partial && <span className="ml-2 whitespace-nowrap text-[10px] uppercase tracking-wide text-muted-foreground">partial</span>}
              </TableCell>
              {cells(r)}
            </TableRow>
          ))}
          <TableRow className="border-t-2 font-semibold hover:bg-transparent" data-testid="total-row">
            <TableCell className="sticky left-0 z-[1] bg-card">Total</TableCell>
            {cells(total)}
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
