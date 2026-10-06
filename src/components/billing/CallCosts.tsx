import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { isSameDay } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  SortableColumnHeader, TableTextFilter, TableSelectFilter, TableDateFilter, TablePagination,
} from "@/components/dashboard/table/TableControls";
import { api } from "@/services/api";
import { CallCostEntry, formatDuration } from "./types";

type CallColumnKey = "created_at" | "contact" | "direction" | "duration_seconds" | "call_cost" | "status";

const CALL_COLUMNS: { key: CallColumnKey; label: string }[] = [
  { key: "created_at", label: "Date" },
  { key: "contact", label: "Contact" },
  { key: "direction", label: "Direction" },
  { key: "duration_seconds", label: "Duration" },
  { key: "call_cost", label: "Cost" },
  { key: "status", label: "Status" },
];

function callTextFor(c: CallCostEntry, key: CallColumnKey): string {
  if (key === "contact") return c.contact_name || c.phone || "Unknown";
  if (key === "duration_seconds") return formatDuration(c.duration_seconds);
  if (key === "call_cost") return String(c.call_cost);
  if (key === "created_at") return c.created_at;
  return (c[key] as string) || "";
}

const CallCosts = () => {
  const [callCosts, setCallCosts] = useState<CallCostEntry[]>([]);
  const [totalCost, setTotalCost] = useState(0);
  const [totalMinutes, setTotalMinutes] = useState(0);
  const [totalCalls, setTotalCalls] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [callSortKey, setCallSortKey] = useState<CallColumnKey | null>(null);
  const [callSortDir, setCallSortDir] = useState<"asc" | "desc">("asc");
  const [callFilters, setCallFilters] = useState<Record<CallColumnKey, string>>({
    created_at: "", contact: "", direction: "", duration_seconds: "", call_cost: "", status: "",
  });
  const [callDateFilter, setCallDateFilter] = useState<Date | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    api.getBillingCallCosts().then(({ data }) => {
      if (data) {
        setCallCosts(data.calls || []);
        setTotalCost(data.total_cost || 0);
        setTotalMinutes(data.total_minutes || 0);
        setTotalCalls(data.total_calls || 0);
        setTruncated(!!data.truncated);
      }
      setLoading(false);
    });
  }, []);

  const toggleCallSort = (key: CallColumnKey) => {
    if (callSortKey !== key) { setCallSortKey(key); setCallSortDir("asc"); return; }
    if (callSortDir === "asc") { setCallSortDir("desc"); return; }
    setCallSortKey(null);
  };

  const setCallFilter = (key: CallColumnKey, value: string) =>
    setCallFilters((f) => ({ ...f, [key]: value }));

  const callDirectionOptions = useMemo(() => {
    const set = new Set(callCosts.map((c) => c.direction).filter(Boolean));
    return Array.from(set).sort();
  }, [callCosts]);

  const callStatusOptions = useMemo(() => {
    const set = new Set(callCosts.map((c) => c.status).filter(Boolean));
    return Array.from(set).sort();
  }, [callCosts]);

  const filteredCallCosts = useMemo(() => {
    return callCosts.filter((c) =>
      CALL_COLUMNS.every(({ key }) => {
        if (key === "created_at") {
          if (!callDateFilter) return true;
          const t = c.created_at ? new Date(c.created_at) : null;
          return !!t && !isNaN(t.getTime()) && isSameDay(t, callDateFilter);
        }
        if (key === "direction") {
          if (!callFilters.direction) return true;
          return c.direction === callFilters.direction;
        }
        if (key === "status") {
          if (!callFilters.status) return true;
          return c.status === callFilters.status;
        }
        const q = callFilters[key].trim().toLowerCase();
        return !q || callTextFor(c, key).toLowerCase().includes(q);
      })
    );
  }, [callCosts, callFilters, callDateFilter]);

  const sortedCallCosts = useMemo(() => {
    if (!callSortKey) return filteredCallCosts;
    return [...filteredCallCosts].sort((a, b) => {
      if (callSortKey === "call_cost" || callSortKey === "duration_seconds") {
        const av = callSortKey === "call_cost" ? a.call_cost : a.duration_seconds;
        const bv = callSortKey === "call_cost" ? b.call_cost : b.duration_seconds;
        return callSortDir === "asc" ? av - bv : bv - av;
      }
      if (callSortKey === "created_at") {
        const av = new Date(a.created_at).getTime();
        const bv = new Date(b.created_at).getTime();
        return callSortDir === "asc" ? av - bv : bv - av;
      }
      const av = callTextFor(a, callSortKey).toLowerCase();
      const bv = callTextFor(b, callSortKey).toLowerCase();
      if (av < bv) return callSortDir === "asc" ? -1 : 1;
      if (av > bv) return callSortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [filteredCallCosts, callSortKey, callSortDir]);

  useEffect(() => { setPage(1); }, [callFilters, callDateFilter, callSortKey, callSortDir, pageSize]);

  const totalPages = Math.max(1, Math.ceil(sortedCallCosts.length / pageSize));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  // With no filter applied the footer shows the account-wide totals from the server
  // (they cover every call, even past the list ceiling); with a filter it sums just
  // the matching rows.
  const filtersActive = !!callDateFilter || Object.values(callFilters).some((v) => v.trim() !== "");
  const footerCost = filtersActive
    ? sortedCallCosts.reduce((sum, c) => sum + (c.call_cost || 0), 0)
    : totalCost;
  const footerMinutes = filtersActive
    ? sortedCallCosts.reduce((sum, c) => sum + (c.duration_seconds || 0), 0) / 60
    : totalMinutes;

  const visibleCallCosts = useMemo(
    () => sortedCallCosts.slice((page - 1) * pageSize, page * pageSize),
    [sortedCallCosts, page, pageSize]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading call costs...
      </div>
    );
  }

  if (callCosts.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No calls yet.
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-4 text-lg font-semibold text-foreground">Call Cost Breakdown</h2>
      {truncated && (
        <p className="mb-3 text-sm text-muted-foreground">
          Showing the latest {callCosts.length.toLocaleString()} of {totalCalls.toLocaleString()} calls.
          With no filter applied, the total below includes every call.
        </p>
      )}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {CALL_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 text-center">
                    <SortableColumnHeader
                      label={label}
                      active={callSortKey === key}
                      dir={callSortDir}
                      onClick={() => toggleCallSort(key)}
                    />
                  </th>
                ))}
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {CALL_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 font-normal normal-case">
                    {key === "created_at" ? (
                      <TableDateFilter value={callDateFilter} onChange={setCallDateFilter} />
                    ) : key === "direction" ? (
                      <TableSelectFilter
                        value={callFilters.direction}
                        onChange={(v) => setCallFilter("direction", v)}
                        placeholder="Direction"
                        options={callDirectionOptions.map((d) => ({ value: d, label: d }))}
                      />
                    ) : key === "status" ? (
                      <TableSelectFilter
                        value={callFilters.status}
                        onChange={(v) => setCallFilter("status", v)}
                        placeholder="Status"
                        options={callStatusOptions.map((s) => ({ value: s, label: s }))}
                      />
                    ) : (
                      <TableTextFilter value={callFilters[key]} onChange={(v) => setCallFilter(key, v)} placeholder={label} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleCallCosts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    No calls match your filters.
                  </td>
                </tr>
              ) : (
                visibleCallCosts.map((call) => (
                  <tr key={call.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-center text-foreground">
                      {new Date(call.created_at).toLocaleDateString()}{" "}
                      <span className="text-xs text-muted-foreground">
                        {new Date(call.created_at).toLocaleTimeString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center font-medium text-foreground">
                      {call.contact_name || call.phone || "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant="outline" className="whitespace-nowrap capitalize">{call.direction}</Badge>
                    </td>
                    <td className="px-4 py-3 text-center text-foreground">
                      {formatDuration(call.duration_seconds)}
                    </td>
                    <td className="px-4 py-3 text-center font-medium text-foreground">
                      ${(call.call_cost || 0).toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={call.status === "Completed" ? "default" : "secondary"} className="whitespace-nowrap">
                        {call.status}
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
              <tr className="divide-x divide-border border-t-2 border-border bg-muted/30 font-semibold">
                <td className="px-4 py-3 text-center text-foreground" colSpan={3}>{filtersActive ? "Total (filtered)" : "Total"}</td>
                <td className="px-4 py-3 text-center text-foreground">{footerMinutes.toFixed(1)} min</td>
                <td className="px-4 py-3 text-center text-foreground">${footerCost.toFixed(2)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
        <TablePagination
          page={page}
          pageSize={pageSize}
          totalCount={sortedCallCosts.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
};

export default CallCosts;
