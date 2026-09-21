import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, ArrowUpDown, CalendarIcon, Loader2, Search, X,
} from "lucide-react";
import { format, isSameDay } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  const [loading, setLoading] = useState(true);
  const [callSortKey, setCallSortKey] = useState<CallColumnKey | null>(null);
  const [callSortDir, setCallSortDir] = useState<"asc" | "desc">("asc");
  const [callFilters, setCallFilters] = useState<Record<CallColumnKey, string>>({
    created_at: "", contact: "", direction: "", duration_seconds: "", call_cost: "", status: "",
  });
  const [callDateFilter, setCallDateFilter] = useState<Date | undefined>(undefined);

  useEffect(() => {
    api.getBillingCallCosts().then(({ data }) => {
      if (data) {
        setCallCosts(data.calls || []);
        setTotalCost(data.total_cost || 0);
        setTotalMinutes(data.total_minutes || 0);
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

  const visibleCallCosts = useMemo(() => {
    const filtered = callCosts.filter((c) =>
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
    if (!callSortKey) return filtered;
    const sorted = [...filtered].sort((a, b) => {
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
    return sorted;
  }, [callCosts, callFilters, callDateFilter, callSortKey, callSortDir]);

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
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {CALL_COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 text-center">
                    <button
                      type="button"
                      onClick={() => toggleCallSort(key)}
                      className="flex w-full items-center justify-between gap-1 hover:text-foreground"
                    >
                      <span>{label}</span>
                      {callSortKey === key ? (
                        callSortDir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />
                      ) : (
                        <ArrowUpDown className="h-3 w-3 shrink-0 opacity-50" />
                      )}
                    </button>
                  </th>
                ))}
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {CALL_COLUMNS.map(({ key, label }) =>
                  key === "created_at" ? (
                    <th key={key} className="px-4 py-3 font-normal normal-case">
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-xs text-muted-foreground hover:bg-muted"
                          >
                            <CalendarIcon className="h-3 w-3 shrink-0" />
                            <span className="flex-1 truncate">{callDateFilter ? format(callDateFilter, "MMM d, yyyy") : "Date"}</span>
                            {callDateFilter && (
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); setCallDateFilter(undefined); }}
                                className="rounded p-0.5 hover:bg-muted-foreground/20"
                              >
                                <X className="h-3 w-3" />
                              </span>
                            )}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <Calendar
                            mode="single"
                            selected={callDateFilter}
                            onSelect={setCallDateFilter}
                            initialFocus
                          />
                        </PopoverContent>
                      </Popover>
                    </th>
                  ) : key === "direction" ? (
                    <th key={key} className="px-4 py-3 font-normal normal-case">
                      <Select
                        value={callFilters.direction || "__all__"}
                        onValueChange={(v) => setCallFilter("direction", v === "__all__" ? "" : v)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Direction" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">All</SelectItem>
                          {callDirectionOptions.map((d) => (
                            <SelectItem key={d} value={d} className="capitalize">{d}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </th>
                  ) : key === "status" ? (
                    <th key={key} className="px-4 py-3 font-normal normal-case">
                      <Select
                        value={callFilters.status || "__all__"}
                        onValueChange={(v) => setCallFilter("status", v === "__all__" ? "" : v)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Status" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__all__">All</SelectItem>
                          {callStatusOptions.map((s) => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </th>
                  ) : (
                    <th key={key} className="px-4 py-3 font-normal normal-case">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={callFilters[key]}
                          onChange={(e) => setCallFilter(key, e.target.value)}
                          placeholder={label}
                          className="h-8 pl-7 text-xs"
                        />
                      </div>
                    </th>
                  )
                )}
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
                      <Badge variant="outline" className="capitalize">{call.direction}</Badge>
                    </td>
                    <td className="px-4 py-3 text-center text-foreground">
                      {formatDuration(call.duration_seconds)}
                    </td>
                    <td className="px-4 py-3 text-center font-medium text-foreground">
                      ${(call.call_cost || 0).toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={call.status === "Completed" ? "default" : "secondary"}>
                        {call.status}
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
              <tr className="divide-x divide-border border-t-2 border-border bg-muted/30 font-semibold">
                <td className="px-4 py-3 text-center text-foreground" colSpan={3}>Total</td>
                <td className="px-4 py-3 text-center text-foreground">{totalMinutes.toFixed(1)} min</td>
                <td className="px-4 py-3 text-center text-foreground">${totalCost.toFixed(2)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CallCosts;
