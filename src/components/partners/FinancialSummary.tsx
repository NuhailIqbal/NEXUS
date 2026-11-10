/**
 * Admin "Financial summary" of the referral partners: for a chosen period (Weekly / Monthly / Annual or a custom range)
 * what the referred users were billed, what the platform paid its providers, the gross profit, the commission earned by
 * partners, the commission actually paid, what is still owed and what the platform keeps. Seven tiles, a trend chart of
 * net kept vs commission earned vs commission paid by period, the same by period as a table (the chart's table view)
 * and a breakdown per partner (paused ones included), with a CSV download of exactly what is on screen.
 * "Still owed" is the balance at the END of the range; the period table shows it at the end of every period.
 * Data: GET /admin/partners/financials (services/partner_financials.py).
 */
import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { useTheme } from "next-themes";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { moneyOrDash } from "@/lib/leadRoi";
import { cn } from "@/lib/utils";
import { periodLabel, periodSpan, reportDay, type ReportQuery } from "@/lib/partnerReports";
import {
  FINANCE_COLORS, FINANCE_SERIES, financeFilename, financePoints, owedWording,
  type FinanceNumbers, type FinancePoint, type FinancialSummaryData,
} from "@/lib/partnerFinancials";
import ReportControls from "./ReportControls";
import { useReportData, useReportSelection } from "./useReportSelection";

const profitClass = (n: number) => (n > 0 ? "text-green-500" : n < 0 ? "text-destructive" : "text-muted-foreground");
const owedClass = (n: number) => (n > 0 ? "font-semibold text-amber-500" : n < 0 ? "font-semibold text-destructive" : "text-muted-foreground");
const th = "px-3 py-3 text-right sm:px-4";
const td = "px-3 py-3 text-right sm:px-4";

const Tile = ({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "profit" | "warn" }) => (
  <div className={cn("rounded-xl border bg-card p-5", tone === "profit" ? "border-green-500/50 bg-green-500/5" : tone === "warn" ? "border-amber-500/50 bg-amber-500/5" : "border-border")}>
    <div className={cn("text-2xl font-bold", tone === "profit" ? "text-green-500" : tone === "warn" ? "text-amber-500" : "text-foreground")}>{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
    {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
  </div>
);

function Tiles({ t, start, end }: { t: FinanceNumbers; start: string; end: string }) {
  const balance = owedWording(t.owed);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Billed from referred users" value={moneyOrDash(t.billed)} />
        <Tile label="Platform cost" value={moneyOrDash(t.platform_cost)} />
        <Tile label="Gross profit (billed − cost)" value={moneyOrDash(t.profit)} tone="profit" />
        <Tile label="Net kept by the platform" value={moneyOrDash(t.net_kept)} hint="Gross profit − commission earned" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile label="Commission earned" value={moneyOrDash(t.commission)} />
        <Tile label="Commission paid" value={moneyOrDash(t.paid)} hint="Payments dated in this range" />
        <Tile
          label={balance.label === "Overpaid to partners" ? "Overpaid to partners (rate was lowered after paying)" : balance.label}
          value={moneyOrDash(Math.abs(t.owed))} tone={balance.tone === "settled" ? undefined : "warn"}
          hint={`At the end of ${reportDay(end)}; it was ${moneyOrDash(t.owed_start)} at the start of ${reportDay(start)}`}
        />
      </div>
    </div>
  );
}

const tooltipStyle = {
  background: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 10, fontSize: 12, padding: "8px 10px",
  color: "hsl(var(--foreground))",
};

function TrendTooltip({ active, payload, colors }: { active?: boolean; payload?: { payload: FinancePoint }[]; colors: Record<string, string> }) {
  const p = payload?.[0]?.payload;
  if (!active || !p) return null;
  return (
    <div style={tooltipStyle}>
      <div className="mb-1 font-medium">{p.tip}</div>
      {FINANCE_SERIES.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-2 text-muted-foreground"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: colors[s.key] }} />{s.label}</span>
          <span className="font-semibold">{moneyOrDash(p[s.key])}</span>
        </div>
      ))}
    </div>
  );
}

const axisMoney = (v: number) => `${v < 0 ? "-" : ""}$${Math.abs(v) >= 1000 ? `${(Math.abs(v) / 1000).toFixed(Math.abs(v) % 1000 === 0 ? 0 : 1)}k` : Math.abs(v)}`;

function Trend({ data }: { data: FinancialSummaryData }) {
  const { resolvedTheme } = useTheme();
  const colors = resolvedTheme === "light" ? FINANCE_COLORS.light : FINANCE_COLORS.dark;
  const points = financePoints(data.periods, data.group);
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-2" data-testid="finance-legend">
        {FINANCE_SERIES.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-sm" style={{ background: colors[s.key] }} />
            <span className="text-sm text-muted-foreground">{s.label}</span>
            <span className="text-sm font-semibold text-foreground">{moneyOrDash(data.total[s.key])}</span>
          </div>
        ))}
      </div>
      <div className="h-72 w-full min-w-0" role="img" aria-label="Net kept, commission earned and commission paid for each period; the same figures are in the table below" data-testid="finance-trend-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2} barCategoryGap="22%">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} tickFormatter={axisMoney} width={52} />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Tooltip cursor={{ fill: "hsl(var(--muted))", fillOpacity: 0.4 }} content={<TrendTooltip colors={colors} />} />
            {FINANCE_SERIES.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={colors[s.key]} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function MoneyCells({ n, strong }: { n: FinanceNumbers; strong?: boolean }) {
  const b = strong ? "font-semibold text-foreground" : "";
  return (
    <>
      <td className={cn(td, b)}>{moneyOrDash(n.billed)}</td>
      <td className={cn(td, b)}>{moneyOrDash(n.platform_cost)}</td>
      <td className={cn(td, "font-semibold", profitClass(n.profit))}>{moneyOrDash(n.profit)}</td>
      <td className={cn(td, b)}>{moneyOrDash(n.commission)}</td>
      <td className={cn(td, b)}>{moneyOrDash(n.paid)}</td>
      <td className={cn(td, owedClass(n.owed))}>{moneyOrDash(n.owed)}</td>
      <td className={cn(td, b)}>{moneyOrDash(n.net_kept)}</td>
    </>
  );
}

function Heads({ owedLabel }: { owedLabel: string }) {
  return (
    <>
      <th className={th}>Billed</th>
      <th className={th}>Platform cost</th>
      <th className={th}>Gross profit</th>
      <th className={th}>Commission earned</th>
      <th className={th}>Commission paid</th>
      <th className={th}>{owedLabel}</th>
      <th className={th}>Net kept</th>
    </>
  );
}

export default function FinancialSummary() {
  const { tz, preset, setPreset, custom, setCustom, query } = useReportSelection("month");
  const { report, error, loading } = useReportData<FinancialSummaryData>(query, (q) => api.getAdminPartnerFinancials(q));
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    if (!report) return;
    setDownloading(true);
    // Asks for the dates on screen, so the file is always the summary being looked at.
    const q: ReportQuery = { group: report.group, start: report.start, end: report.end, tz: report.tz };
    const { error: err } = await api.downloadAdminPartnerFinancials(q, financeFilename(report));
    setDownloading(false);
    if (err) toast.error(err);
  };

  const rows = report ? [...report.periods].reverse() : [];      // newest first on screen, the CSV runs oldest first

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Financial summary</h2>
          <p className="text-sm text-muted-foreground">
            What partners&apos; referred users brought in, what was earned by and paid to partners, and what the platform keeps. Periods follow your time zone ({tz}); weeks start on Monday.
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={download} disabled={!report || !query || downloading || loading}>
          {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Download CSV
        </Button>
      </div>

      <ReportControls preset={preset} onPreset={setPreset} custom={custom} onCustom={setCustom} />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {query && !report && !error && (
        <div className="flex items-center justify-center py-10 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>
      )}

      {report && query && (
        <div className={cn("space-y-6 transition-opacity", loading && "opacity-60")}>
          <p className="text-xs text-muted-foreground">{reportDay(report.start)} – {reportDay(report.end)} · every partner, paused ones included</p>
          <Tiles t={report.total} start={report.start} end={report.end} />
          <Trend data={report} />

          <div>
            <h3 className="text-sm font-semibold text-foreground">By period</h3>
            <div className="mt-2 overflow-hidden rounded-xl border border-border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr><th className="px-3 py-3 text-left sm:px-4">Period</th><Heads owedLabel="Owed at period end" /></tr>
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
                          <MoneyCells n={r} />
                        </tr>
                      );
                    })}
                    <tr className="border-t-2 border-border bg-muted/30">
                      <td className="px-3 py-3 text-left font-semibold text-foreground sm:px-4">Total</td>
                      <MoneyCells n={report.total} strong />
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">By partner, over the same dates</h3>
            <div className="mt-2 overflow-hidden rounded-xl border border-border">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr><th className="px-3 py-3 text-left sm:px-4">Partner</th><Heads owedLabel="Still owed" /></tr>
                  </thead>
                  <tbody>
                    {report.partners.length === 0 ? (
                      <tr><td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">No partners yet.</td></tr>
                    ) : report.partners.map((p) => (
                      <tr key={p.id} className="border-t border-border bg-card/30">
                        <td className="px-3 py-3 text-left sm:px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-foreground">{p.name}</span>
                            {p.status !== "active" && <Badge variant="secondary">Paused</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground">{p.commission_label}</div>
                        </td>
                        <MoneyCells n={p.total} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
