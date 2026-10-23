/**
 * The lead/number view of one campaign: every number with how many calls it has had, how the last one
 * ended, when the next retry is due and its status; a row opens to the history of each call. Reads
 * api.getCampaignNumbers (backend: GET /telephony/campaigns/:id/numbers). Times are shown in the
 * campaign's own time zone when it has one, else the viewer's (named either way).
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { formatInZone } from "@/lib/timeZone";
import {
  NUMBER_FILTERS, OUTCOME_LABELS, STATUS_LABELS, type CampaignNumber,
} from "@/lib/callRetry";

type Props = {
  campaignId: string | null;
  campaignName?: string;
  /** The campaign's calling-hours zone, if it has one chosen. */
  timezone?: string | null;
  onOpenChange: (open: boolean) => void;
};

const PAGE = 100;

/** Colour of the status text: finished well, finished without success, or still going. */
const statusClass = (s: string) =>
  ["answered", "transferred"].includes(s) ? "text-success"
    : ["max_attempts", "not_retried", "invalid_number", "do_not_call", "disqualified"].includes(s) ? "text-muted-foreground"
      : "text-primary";

export function CampaignNumbersDialog({ campaignId, campaignName, timezone, onOpenChange }: Props) {
  const [filter, setFilter] = useState("all");
  const [rows, setRows] = useState<CampaignNumber[]>([]);
  const [total, setTotal] = useState(0);
  const [retry, setRetry] = useState<{ enabled: boolean; max_attempts: number; interval_minutes: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async (offset: number, replace: boolean) => {
    if (!campaignId) return;
    setLoading(true);
    const { data, error: err } = await api.getCampaignNumbers(campaignId, { status: filter, limit: PAGE, offset });
    setLoading(false);
    if (err || !data) {
      setError(err || "Could not load the numbers.");
      return;
    }
    setError(null);
    const d = data as { rows: CampaignNumber[]; total: number; retry: typeof retry };
    setRows((prev) => (replace ? d.rows : [...prev, ...d.rows]));
    setTotal(d.total);
    setRetry(d.retry);
  }, [campaignId, filter]);

  useEffect(() => {
    if (!campaignId) return;
    setOpen(null);
    load(0, true);
  }, [campaignId, filter, load]);

  const when = (v: string | null) => (v ? formatInZone(v, timezone) : "—");
  const outcome = (v: string | null) => (v ? OUTCOME_LABELS[v] ?? v : "—");

  return (
    <Dialog open={!!campaignId} onOpenChange={(o) => { if (!o) { onOpenChange(false); setRows([]); setFilter("all"); } }}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle>Numbers{campaignName ? ` · ${campaignName}` : ""}</DialogTitle>
          <DialogDescription>
            {retry?.enabled
              ? `Up to ${retry.max_attempts} call${retry.max_attempts === 1 ? "" : "s"} per number, ${retry.interval_minutes} minute${retry.interval_minutes === 1 ? "" : "s"} after a call ends.`
              : "Auto redial is off for this campaign: each number is called once."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-full sm:w-56" aria-label="Show">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NUMBER_FILTERS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{total.toLocaleString()} number{total === 1 ? "" : "s"}</span>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="w-8 px-2 py-2" aria-label="History" />
                <th className="px-3 py-2 font-medium">Number</th>
                <th className="px-3 py-2 font-medium">Attempts</th>
                <th className="px-3 py-2 font-medium">Last outcome</th>
                <th className="px-3 py-2 font-medium">Next redial</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr className="border-t border-border">
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          aria-label={`${isOpen ? "Hide" : "Show"} calls of ${r.phone}`}
                          aria-expanded={isOpen}
                          onClick={() => setOpen(isOpen ? null : r.id)}
                          className="rounded p-1 text-muted-foreground hover:bg-muted"
                        >
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{r.phone}</div>
                        {r.name && r.name !== r.phone && <div className="text-xs text-muted-foreground">{r.name}</div>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">{r.attempts} of {r.max_attempts}</td>
                      <td className="px-3 py-2">{outcome(r.last_outcome)}</td>
                      <td className="px-3 py-2">{when(r.next_attempt_at)}</td>
                      <td className={`px-3 py-2 font-medium ${statusClass(r.status)}`}>{STATUS_LABELS[r.status] ?? r.status}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-border bg-muted/20">
                        <td />
                        <td colSpan={5} className="px-3 py-2">
                          {r.history.length === 0 ? (
                            <span className="text-xs text-muted-foreground">No calls yet.</span>
                          ) : (
                            <ul className="space-y-1 text-xs">
                              {r.history.map((h) => (
                                <li key={`${h.round}-${h.attempt_number}`} className="flex flex-wrap gap-x-3">
                                  <span className="font-medium">Attempt {h.attempt_number}{r.round > 1 ? ` (round ${h.round})` : ""}</span>
                                  <span>placed {when(h.placed_at)}</span>
                                  <span>{h.ended_at ? `ended ${when(h.ended_at)}` : "in progress"}</span>
                                  <span className="text-muted-foreground">{h.outcome ? outcome(h.outcome) : ""}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!loading && rows.length === 0 && !error && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {filter === "all" ? "No calls have been placed by this campaign yet." : "No numbers match this filter."}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-center">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading" />
          ) : rows.length < total ? (
            <Button variant="outline" size="sm" onClick={() => load(rows.length, false)}>Load more</Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

