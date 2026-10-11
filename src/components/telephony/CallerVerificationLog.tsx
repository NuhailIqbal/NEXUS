/**
 * Recent caller checks for one phone number: who called, whether the agent answered or the call was
 * turned away, and why. Loads GET /telephony/caller-verification/log when it mounts (and again if
 * the number changes), so it is the place to look when someone asks "why didn't my call get through?".
 */
import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { api } from "@/services/api";
import { describeScreening, type CallerVerificationLogRow } from "@/lib/callerVerification";

export function CallerVerificationLog({ phoneNumberId, limit = 5 }: { phoneNumberId: string; limit?: number }) {
  const [rows, setRows] = useState<CallerVerificationLogRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    api.getCallerVerificationLog(`phone_number_id=${encodeURIComponent(phoneNumberId)}&limit=${limit}`).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !Array.isArray(data)) setFailed(true);
      else setRows(data as CallerVerificationLogRow[]);
    });
    return () => { cancelled = true; };
  }, [phoneNumberId, limit]);

  return (
    <div className="space-y-2" aria-live="polite">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent checks</h4>
      {failed ? (
        <p className="text-xs text-muted-foreground">Couldn't load recent checks.</p>
      ) : rows === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No calls have been checked yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          {rows.map((r) => {
            const { label, refused } = describeScreening(r);
            const when = new Date(r.created_at);
            return (
              // On a phone each row stacks (the whole number stays readable); from `sm` up the outcome
              // and time sit on the right.
              <li key={r.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 font-medium ${
                      refused ? "bg-destructive/10 text-destructive" : "bg-success/15 text-success"
                    }`}
                  >
                    {refused ? "Turned away" : "Answered"}
                  </span>
                  <span className="min-w-0 break-all font-mono text-foreground">{r.caller_number || "No number"}</span>
                </div>
                <div className="flex flex-wrap gap-x-2 text-muted-foreground sm:shrink-0 sm:flex-col sm:items-end sm:text-right">
                  <span>{label}</span>
                  {!isNaN(when.getTime()) && <span>{formatDistanceToNow(when, { addSuffix: true })}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
