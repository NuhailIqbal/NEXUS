/**
 * Commission report by period, shared by the admin Partners page and the Partner Portal. A period selector (Weekly /
 * Monthly / Annual over their usual range, or a custom date range grouped by day, week, month or year), a table with
 * one row per period (signups, verified signups, billed, commission earned) and a total, and a CSV download of exactly
 * what is on screen. The admin version adds the platform's cost, profit and net profit and can narrow to one partner;
 * the partner version never receives those three figures (the server leaves them out).
 * Data: GET /admin/partners/reports and GET /partner/report (services/partner_reports.py).
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { moneyOrDash } from "@/lib/leadRoi";
import { cn } from "@/lib/utils";
import {
  periodLabel, periodSpan, reportDay, reportFilename, type CommissionReportData, type ReportNumbers, type ReportQuery,
} from "@/lib/partnerReports";
import ReportControls from "./ReportControls";
import { useReportData, useReportSelection } from "./useReportSelection";

type Props = {
  admin?: boolean;
  /** Admin only: the partners to choose from (the report covers all of them by default). */
  partners?: { id: string; name: string }[];
};

const profitClass = (n: number) => (n > 0 ? "text-green-500" : n < 0 ? "text-destructive" : "text-muted-foreground");
const th = "px-3 py-3 text-right sm:px-4";
const td = "px-3 py-3 text-right sm:px-4";

function NumberCells({ n, admin, strong }: { n: ReportNumbers; admin: boolean; strong?: boolean }) {
  const b = strong ? "font-semibold text-foreground" : "";
  return (
    <>
      <td className={cn(td, b)}>{n.signups}</td>
      <td className={cn(td, b)}>{n.verified}</td>
      <td className={cn(td, b)}>{moneyOrDash(n.billed)}</td>
      {admin && <td className={cn(td, b)}>{moneyOrDash(n.platform_cost ?? 0)}</td>}
      {admin && <td className={cn(td, "font-semibold", profitClass(n.profit ?? 0))}>{moneyOrDash(n.profit ?? 0)}</td>}
      <td className={cn(td, b)}>{moneyOrDash(n.commission)}</td>
      {admin && <td className={cn(td, b)}>{moneyOrDash(n.net_profit ?? 0)}</td>}
    </>
  );
}

function ColumnHeads({ admin }: { admin: boolean }) {
  return (
    <>
      <th className={th}>Signups</th>
      <th className={th}>Verified</th>
      <th className={th}>Billed</th>
      {admin && <th className={th}>Platform cost</th>}
      {admin && <th className={th}>Profit</th>}
      <th className={th}>Commission earned</th>
      {admin && <th className={th}>Platform net profit</th>}
    </>
  );
}

export default function CommissionReport({ admin = false, partners = [] }: Props) {
  const { tz, preset, setPreset, custom, setCustom, partnerId, setPartnerId, query } = useReportSelection("week", admin);
  const { report, error, loading } = useReportData<CommissionReportData>(query, (q) => (admin ? api.getAdminPartnerReport(q) : api.getPartnerReport(q)));
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    if (!report) return;
    setDownloading(true);
    // The CSV asks for the dates on screen, so it is always the report being looked at (not a moved default range).
    const q: ReportQuery = { group: report.group, start: report.start, end: report.end, tz: report.tz, ...(admin && partnerId !== "all" ? { partner_id: partnerId } : {}) };
    const scope = admin ? (partnerId === "all" ? "all-partners" : partners.find((p) => p.id === partnerId)?.name ?? "partner") : undefined;
    const { error: err } = await (admin ? api.downloadAdminPartnerReport(q, reportFilename(report, scope)) : api.downloadPartnerReport(q, reportFilename(report, scope)));
    setDownloading(false);
    if (err) toast.error(err);
  };

  const rows = report ? [...report.periods].reverse() : [];     // newest first on screen, the CSV runs oldest first
  const showByPartner = admin && !!report?.partners && report.partners.length > 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Commission reports</h2>
          <p className="text-sm text-muted-foreground">
            {admin ? "Signups, billing and commission for each period." : "What you earned in each period."} Periods follow your time zone ({tz}); weeks start on Monday.
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={download} disabled={!report || !query || downloading || loading}>
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download CSV
        </Button>
      </div>

      <ReportControls
        preset={preset} onPreset={setPreset} custom={custom} onCustom={setCustom}
        partners={admin ? partners : []} partnerId={partnerId} onPartner={setPartnerId}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      {query && !report && !error && (
        <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>
      )}

      {report && query && (
        <div className={cn("space-y-4 transition-opacity", loading && "opacity-60")}>
          <p className="text-xs text-muted-foreground">
            {reportDay(report.start)} – {reportDay(report.end)}
            {!admin && report.commission_label ? <> · Your rate: <strong className="text-foreground">{report.commission_label}</strong></> : null}
          </p>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className={cn("w-full text-sm", admin ? "min-w-[980px]" : "min-w-[560px]")}>
                <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-3 text-left sm:px-4">Period</th>
                    <ColumnHeads admin={admin} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const span = periodSpan(report.group, r);
                    return (
                      <tr key={r.key} className="border-t border-border bg-card/30">
                        <td className="whitespace-nowrap px-3 py-3 text-left sm:px-4">
                          <div className="font-medium text-foreground">{periodLabel(report.group, r.key)}</div>
                          {span && <div className="text-xs text-muted-foreground">{span}</div>}
                        </td>
                        <NumberCells n={r} admin={admin} />
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-border bg-muted/30">
                    <td className="px-3 py-3 text-left font-semibold text-foreground sm:px-4">Total</td>
                    <NumberCells n={report.total} admin={admin} strong />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {showByPartner && (
            <div>
              <h3 className="text-sm font-semibold text-foreground">By partner, over the same dates</h3>
              <div className="mt-2 overflow-hidden rounded-xl border border-border">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[980px] text-sm">
                    <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-3 text-left sm:px-4">Partner</th>
                        <ColumnHeads admin />
                      </tr>
                    </thead>
                    <tbody>
                      {report.partners!.map((p) => (
                        <tr key={p.id} className="border-t border-border bg-card/30">
                          <td className="px-3 py-3 text-left sm:px-4">
                            <div className="font-medium text-foreground">{p.name}</div>
                            <div className="text-xs text-muted-foreground">{p.commission_label}</div>
                          </td>
                          <NumberCells n={p.total} admin />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
