/**
 * Commission report by period, shared by the admin Partners page and the Partner Portal. A period selector (Weekly /
 * Monthly / Annual over their usual range, or a custom date range grouped by day, week, month or year), a table with
 * one row per period (signups, verified signups, billed, commission earned) and a total, and a CSV download of exactly
 * what is on screen. The admin version adds the platform's cost, profit and net profit and can narrow to one partner;
 * the partner version never receives those three figures (the server leaves them out).
 * Data: GET /admin/partners/reports and GET /partner/report (services/partner_reports.py).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/call-consumption/FilterBar";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";
import { moneyOrDash } from "@/lib/leadRoi";
import { cn } from "@/lib/utils";
import { todayISO } from "@/lib/partners";
import {
  CUSTOM_GROUPS, PRESETS, browserTimeZone, buildReportQuery, customRangeError, periodLabel, periodSpan,
  reportDay, reportFilename,
  type CommissionReportData, type ReportGroup, type ReportNumbers, type ReportPreset, type ReportQuery,
} from "@/lib/partnerReports";

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
  const tz = useMemo(browserTimeZone, []);
  const today = todayISO();
  const [preset, setPreset] = useState<ReportPreset>("week");
  const [custom, setCustom] = useState<{ group: ReportGroup; start: string; end: string }>({ group: "day", start: "", end: "" });
  const [partnerId, setPartnerId] = useState("all");
  const [report, setReport] = useState<CommissionReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const query = useMemo(() => buildReportQuery(preset, custom, admin ? partnerId : "all", tz, today), [preset, custom, partnerId, admin, tz, today]);
  const rangeError = preset === "custom" ? customRangeError(custom.start, custom.end, today) : null;

  const fetchReport = useCallback(async (q: ReportQuery, signal: { stale: boolean }) => {
    setLoading(true);
    const { data, error: err } = admin ? await api.getAdminPartnerReport(q) : await api.getPartnerReport(q);
    if (signal.stale) return;       // a newer selection has been made since this request started
    setLoading(false);
    if (err || !data) {
      setError(typeof err === "string" ? err : "Could not load the report.");
      return;
    }
    setError(null);
    setReport(data);
  }, [admin]);

  useEffect(() => {
    if (!query) return;
    const signal = { stale: false };
    fetchReport(query, signal);
    return () => { signal.stale = true; };
  }, [query, fetchReport]);

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

      <div className="flex flex-wrap items-end gap-3">
        <div className="inline-flex flex-wrap rounded-lg border border-border bg-card/40 p-1" role="group" aria-label="Report period">
          {PRESETS.map((p) => (
            <button
              key={p.value} type="button" aria-pressed={preset === p.value} title={p.hint}
              onClick={() => setPreset(p.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                preset === p.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {preset === "custom" && (
          <>
            <DateField label="From" className="w-40 min-w-0 flex-none" value={custom.start} onChange={(v) => setCustom({ ...custom, start: v })} />
            <DateField label="To" className="w-40 min-w-0 flex-none" value={custom.end} onChange={(v) => setCustom({ ...custom, end: v })} />
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Group by</Label>
              <Select value={custom.group} onValueChange={(v) => setCustom({ ...custom, group: v as ReportGroup })}>
                <SelectTrigger className="w-32" aria-label="Group by"><SelectValue /></SelectTrigger>
                <SelectContent>{CUSTOM_GROUPS.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </>
        )}

        {admin && partners.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Partner</Label>
            <Select value={partnerId} onValueChange={setPartnerId}>
              <SelectTrigger className="w-56" aria-label="Partner"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All partners</SelectItem>
                {partners.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {rangeError && <p className="text-sm text-destructive">{rangeError}</p>}
      {preset === "custom" && !query && !rangeError && <p className="text-sm text-muted-foreground">Pick a start and an end date to see the report.</p>}
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
