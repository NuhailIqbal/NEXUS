/**
 * Inbound Call Logs page (route /dashboard/telephony/inbound-logs). Server-side filtered
 * and paginated table of inbound conversations (api.getConversations with direction=inbound),
 * summary stats (api.getConversationStats), and a detail dialog with recording and transcript.
 */
import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { PhoneIncoming, Loader2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SortableColumnHeader, TableTextFilter, TableSelectFilter, TablePagination,
} from "@/components/dashboard/table/TableControls";
import { api } from "@/services/api";
import CallAudioPlayer, { CallAudioPlayerHandle } from "@/components/conversations/CallAudioPlayer";
import CallTranscript, { TranscriptMessage } from "@/components/conversations/CallTranscript";

type CallLog = {
  id: string;
  status: string;
  duration?: string;
  duration_seconds?: number;
  call_time?: string;
  phone?: string;
  contact_name?: string;
  agent_name?: string;
  ai_summary?: string;
  transcript?: string;
  transcript_messages?: TranscriptMessage[] | null;
  recording_url?: string;
  stereo_recording_url?: string;
  direction?: string;
  sentiment?: string;
};

/** Maps a call status to the Tailwind classes for its badge; unknown statuses get a muted style. */
const colorFor = (s: string) =>
  s === "Completed" ? "bg-success/15 text-success" :
  s === "Failed" || s === "Unsuccessful" ? "bg-destructive/15 text-destructive" :
  s === "Ringing" ? "bg-warning/15 text-warning" :
  s === "In Progress" || s === "Initiated" ? "bg-info/15 text-info" :
  "bg-muted text-muted-foreground";

type ColumnKey = "contact_name" | "agent_name" | "status" | "duration" | "call_time";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "contact_name", label: "Caller" },
  { key: "agent_name", label: "Agent" },
  { key: "status", label: "Status" },
  { key: "duration", label: "Duration" },
  { key: "call_time", label: "Time" },
];

/** Returns the display text of a column for a call; used for client-side sorting of the current page. */
function textFor(c: CallLog, key: ColumnKey): string {
  if (key === "contact_name") return c.contact_name || c.phone || "Unknown";
  if (key === "duration") return c.duration || (c.duration_seconds ? `${c.duration_seconds}s` : "");
  return (c[key] as string) || "";
}

const STATUS_OPTIONS = ["Initiated", "Ringing", "In Progress", "Completed", "Failed", "Unsuccessful"];
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

/**
 * Page component. Filtering and pagination happen on the server (query params);
 * sorting is client-side and only reorders the rows of the current page. The list
 * auto-refreshes every 30 seconds without showing the loading spinner.
 */
const InboundLogs = () => {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [statTotals, setStatTotals] = useState({ completed: 0, failed: 0, durationSeconds: 0 });
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<CallLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const playerRef = useRef<CallAudioPlayerHandle | null>(null);
  // Id of the call whose dialog is open; async responses compare against it to discard
  // results that arrive after the user closed or switched to another call.
  const openIdRef = useRef<string | null>(null);

  const [sortKey, setSortKey] = useState<ColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({
    contact_name: "", agent_name: "", status: "", duration: "", call_time: "",
  });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Cycles a column through ascending, descending, then unsorted; clicking a new column starts ascending.
  const toggleSort = (key: ColumnKey) => {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null);
  };
  const setFilter = (key: ColumnKey, value: string) => setFilters((f) => ({ ...f, [key]: value }));

  // Filters are debounced (400 ms) so typing does not fire a request per keystroke.
  const [debouncedFilters, setDebouncedFilters] = useState(filters);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilters(filters), 400);
    return () => clearTimeout(t);
  }, [filters]);

  // Fetches the current page of inbound calls plus overall inbound stats. With silent=true
  // (background polling) the full-page loading state is not toggled. The call_time filter is
  // not sent to the server. Total count comes from the response meta.
  const fetchLogs = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const p = new URLSearchParams();
    p.set("direction", "inbound");
    if (debouncedFilters.contact_name.trim()) p.set("contact_name", debouncedFilters.contact_name.trim());
    if (debouncedFilters.agent_name.trim()) p.set("agent_name", debouncedFilters.agent_name.trim());
    if (debouncedFilters.status) p.set("status", debouncedFilters.status);
    if (debouncedFilters.duration.trim()) p.set("duration", debouncedFilters.duration.trim());
    p.set("limit", String(pageSize));
    p.set("offset", String((page - 1) * pageSize));

    const [cRes, statsRes] = await Promise.all([
      api.getConversations(p.toString()),
      api.getConversationStats("direction=inbound"),
    ]);
    if (Array.isArray(cRes.data)) setLogs(cRes.data);
    setTotalCount((cRes as any).meta?.count ?? 0);
    if (statsRes.data) {
      const s = statsRes.data as any;
      setStatTotals({ completed: s.completed ?? 0, failed: s.failed ?? 0, durationSeconds: s.total_duration_seconds ?? 0 });
    }
    if (!silent) setLoading(false);
  }, [debouncedFilters, page, pageSize]);

  useEffect(() => {
    fetchLogs();
    const t = setInterval(() => fetchLogs(true), 30000);
    return () => clearInterval(t);
  }, [fetchLogs]);

  // Return to the first page whenever the result set changes shape.
  useEffect(() => { setPage(1); }, [debouncedFilters, pageSize]);

  // Clamp the page if the total shrinks (e.g. after a refresh) below the current page.
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  const visibleLogs = useMemo(() => {
    if (!sortKey) return logs;
    return [...logs].sort((a, b) => {
      const av = textFor(a, sortKey).toLowerCase();
      const bv = textFor(b, sortKey).toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [logs, sortKey, sortDir]);

  /**
   * Opens the detail dialog for a call. Fetches a playable recording URL (only if the call
   * has a recording) and, when the list row lacks transcript messages, lazily loads the
   * transcript/summary via api.getConversationTranscript and merges it into the open call.
   * Responses are ignored if another call was opened in the meantime.
   */
  const openDetail = async (log: CallLog) => {
    setDetail(log);
    setPlayerTime(0);
    openIdRef.current = log.id;
    setRecordingUrl(null);
    if (log.recording_url || log.stereo_recording_url) {
      api.getConversationRecordingUrl(log.id).then(({ data }) => {
        if (openIdRef.current === log.id) setRecordingUrl((data as any)?.url ?? null);
      });
    }
    if (!log.transcript_messages || log.transcript_messages.length === 0) {
      setDetailLoading(true);
      const { data } = await api.getConversationTranscript(log.id);
      if (openIdRef.current !== log.id) return;
      if (data) {
        setDetail((d) => d && d.id === log.id ? {
          ...d,
          transcript: (data as any).transcript ?? d.transcript,
          transcript_messages: (data as any).transcript_messages ?? d.transcript_messages,
          recording_url: (data as any).recording_url ?? d.recording_url,
          stereo_recording_url: (data as any).stereo_recording_url ?? d.stereo_recording_url,
          ai_summary: (data as any).ai_summary ?? d.ai_summary,
        } : d);
      }
      setDetailLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading call logs...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Inbound Call Logs</h1>
        <p className="text-sm text-muted-foreground">All incoming calls received by your AI receptionists.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-foreground">{totalCount}</div>
          <div className="text-xs text-muted-foreground">Total Calls</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-green-600">{statTotals.completed}</div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-destructive">{statTotals.failed}</div>
          <div className="text-xs text-muted-foreground">Failed</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-foreground">{Math.round(statTotals.durationSeconds / 60)}m</div>
          <div className="text-xs text-muted-foreground">Total Talk Time</div>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              <tr className="divide-x divide-border">
                {COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3">
                    <SortableColumnHeader label={label} active={sortKey === key} dir={sortDir} onClick={() => toggleSort(key)} />
                  </th>
                ))}
                <th className="px-4 py-3 w-20">Actions</th>
              </tr>
              <tr className="divide-x divide-border border-t border-border">
                {COLUMNS.map(({ key, label }) => (
                  <th key={key} className="px-4 py-3 font-normal normal-case">
                    {key === "status" ? (
                      <TableSelectFilter
                        value={filters.status}
                        onChange={(v) => setFilter("status", v)}
                        placeholder="Status"
                        options={STATUS_OPTIONS.map((s) => ({ value: s, label: s }))}
                      />
                    ) : (
                      <TableTextFilter value={filters[key]} onChange={(v) => setFilter(key, v)} placeholder={label} />
                    )}
                  </th>
                ))}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visibleLogs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                    {totalCount === 0 ? "No inbound calls recorded yet." : "No calls match your filters."}
                  </td>
                </tr>
              ) : (
                visibleLogs.map((c) => (
                  <tr key={c.id} className="divide-x divide-border border-t border-border bg-card/30">
                    <td className="px-4 py-3 text-center font-medium text-foreground">
                      {c.contact_name || c.phone || "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">{c.agent_name || "—"}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${colorFor(c.status)}`}>{c.status}</span>
                    </td>
                    <td className="px-4 py-3 text-center text-muted-foreground">
                      {c.duration || (c.duration_seconds ? `${c.duration_seconds}s` : "—")}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-center text-muted-foreground">
                      {c.call_time ? new Date(c.call_time).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => openDetail(c)}
                        className="rounded-md p-2.5 sm:p-1.5 text-muted-foreground hover:bg-muted hover:text-primary"
                        title="View details"
                      >
                        <FileText className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <TablePagination
          page={page}
          pageSize={pageSize}
          totalCount={totalCount}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRefresh={() => fetchLogs()}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
        />
      </div>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 pr-6">
              <PhoneIncoming className="h-5 w-5 text-primary" />
              Call Details
            </DialogTitle>
            <DialogDescription>
              {detail?.contact_name || detail?.phone || "Unknown caller"} &bull; {detail?.call_time ? new Date(detail.call_time).toLocaleString() : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Status</div>
                <div className="mt-1 font-medium">{detail?.status}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Duration</div>
                <div className="mt-1 font-medium">{detail?.duration || (detail?.duration_seconds ? `${detail.duration_seconds}s` : "—")}</div>
              </div>
              <div className="col-span-2 rounded-lg border border-border p-3 sm:col-span-1">
                <div className="text-xs text-muted-foreground">Agent</div>
                <div className="mt-1 font-medium">{detail?.agent_name || "—"}</div>
              </div>
            </div>

            {detail?.ai_summary && (
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-1">AI Summary</h4>
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{detail.ai_summary}</div>
              </div>
            )}

            <div>
              <h4 className="text-sm font-semibold text-foreground mb-1">Recording</h4>
              {(detail?.recording_url || detail?.stereo_recording_url) && recordingUrl === null ? (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading recording…
                </div>
              ) : (
                <CallAudioPlayer
                  ref={playerRef}
                  src={recordingUrl}
                  onTimeUpdate={setPlayerTime}
                />
              )}
            </div>

            <div>
              <h4 className="text-sm font-semibold text-foreground mb-1">Transcript</h4>
              {detailLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript...
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-muted/20 p-3 max-h-72 overflow-y-auto">
                  <CallTranscript
                    messages={detail?.transcript_messages}
                    transcript={detail?.transcript}
                    activeTime={playerTime}
                    onSeek={(s) => playerRef.current?.seek(s)}
                  />
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDetail(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default InboundLogs;
