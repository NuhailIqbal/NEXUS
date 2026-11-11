/**
 * What the partner report screens (CommissionReport, FinancialSummary, the partner's user list) share: the period the user picked and the
 * server request it turns into (useReportSelection), and loading that request with the usual guard against a slow
 * answer to an older selection overwriting a newer one (useReportData).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { todayISO } from "@/lib/partners";
import { browserTimeZone, buildReportQuery, type ReportGroup, type ReportPreset, type ReportQuery } from "@/lib/partnerReports";

export type CustomRange = { group: ReportGroup; start: string; end: string };

/** The period controls' state. `admin` is whether a partner can be picked (otherwise the report always covers everyone). */
export function useReportSelection(initial: ReportPreset, admin = false) {
  const tz = useMemo(browserTimeZone, []);
  const today = todayISO();
  const [preset, setPreset] = useState<ReportPreset>(initial);
  const [custom, setCustom] = useState<CustomRange>({ group: "day", start: "", end: "" });
  const [partnerId, setPartnerId] = useState("all");
  const query = useMemo(() => buildReportQuery(preset, custom, admin ? partnerId : "all", tz, today), [preset, custom, partnerId, admin, tz, today]);
  return { tz, preset, setPreset, custom, setCustom, partnerId, setPartnerId, query };
}

/** Loads `load(query)` whenever the query changes (nothing while it is null). Keeps the last report on screen while the
 *  next one loads; a failure shows its message. */
export function useReportData<T, Q = ReportQuery>(query: Q | null, load: (q: Q) => Promise<{ data?: T | null; error?: unknown }>) {
  const [report, setReport] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!query) { setLoading(false); return; }
    let stale = false;        // a newer selection has been made since this request started
    setLoading(true);
    loadRef.current(query).then(({ data, error: err }) => {
      if (stale) return;
      setLoading(false);
      if (err || !data) {
        setError(typeof err === "string" ? err : "Could not load the report.");
        return;
      }
      setError(null);
      setReport(data);
    });
    return () => { stale = true; };
  }, [query]);

  return { report, error, loading };
}
