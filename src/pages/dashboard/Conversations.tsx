import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown, CalendarIcon, Eye, Loader2, Search, X } from "lucide-react";
import { format, isSameDay } from "date-fns";
import { api } from "@/services/api";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import CallAudioPlayer, { CallAudioPlayerHandle } from "@/components/conversations/CallAudioPlayer";
import CallTranscript, { TranscriptMessage } from "@/components/conversations/CallTranscript";

const colorFor = (s: string) =>
  s === "Completed" ? "bg-success/15 text-success" :
  s === "Unsuccessful" ? "bg-destructive/15 text-destructive" :
  s === "Ringing" ? "bg-warning/15 text-warning" :
  s === "In Progress" || s === "Initiated" ? "bg-info/15 text-info" :
  "bg-muted text-muted-foreground";

type Conversation = {
  id: string;
  channel: string;
  contact_name: string;
  phone: string;
  duration: string;
  status: string;
  qualified: boolean;
  transferred_to: string | null;
  call_time: string;
  transcript: string | null;
  transcript_messages: TranscriptMessage[] | null;
  recording_url: string | null;
  stereo_recording_url: string | null;
  ai_summary: string | null;
  direction: string;
};

type StatItem = { label: string; count: number };

type ColumnKey = "channel" | "contact_name" | "phone" | "duration" | "status" | "qualified" | "call_time";

const COLUMNS: { key: ColumnKey; label: string; width?: string }[] = [
  { key: "channel", label: "Channel" },
  { key: "contact_name", label: "Contact" },
  { key: "phone", label: "Phone" },
  { key: "duration", label: "Duration", width: "w-36" },
  { key: "status", label: "Status", width: "w-36" },
  { key: "qualified", label: "Qualified", width: "w-36" },
  { key: "call_time", label: "Time" },
];

function textFor(c: Conversation, key: ColumnKey): string {
  if (key === "qualified") return c.qualified ? "Qualified" : "—";
  return (c[key] as string) || "";
}

function formatCallTime(value: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return format(d, "MMM d, yyyy, h:mm a");
}

const Conversations = () => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stats, setStats] = useState<StatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<Conversation | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [playerTime, setPlayerTime] = useState(0);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  const playerRef = useRef<CallAudioPlayerHandle | null>(null);
  const openIdRef = useRef<string | null>(null);
  const [sortKey, setSortKey] = useState<ColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filters, setFilters] = useState<Record<ColumnKey, string>>({
    channel: "", contact_name: "", phone: "", duration: "", status: "", qualified: "", call_time: "",
  });
  const [dateFilter, setDateFilter] = useState<Date | undefined>(undefined);

  // Clicking a header cycles: ascending -> descending -> reset (no sort) -> ascending...
  const toggleSort = (key: ColumnKey) => {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null); // was descending -> reset
  };

  const setFilter = (key: ColumnKey, value: string) => setFilters((f) => ({ ...f, [key]: value }));

  const visibleConversations = useMemo(() => {
    const filtered = conversations.filter((c) =>
      COLUMNS.every(({ key }) => {
        if (key === "call_time") {
          if (!dateFilter) return true;
          const t = c.call_time ? new Date(c.call_time) : null;
          return !!t && !isNaN(t.getTime()) && isSameDay(t, dateFilter);
        }
        if (key === "qualified") {
          if (!filters.qualified) return true;
          return filters.qualified === "yes" ? c.qualified : !c.qualified;
        }
        const q = filters[key].trim().toLowerCase();
        return !q || textFor(c, key).toLowerCase().includes(q);
      })
    );
    if (!sortKey) return filtered;
    const sorted = [...filtered].sort((a, b) => {
      const av = textFor(a, sortKey).toLowerCase();
      const bv = textFor(b, sortKey).toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [conversations, filters, dateFilter, sortKey, sortDir]);

  const statusOptions = useMemo(() => {
    const set = new Set(conversations.map((c) => c.status).filter(Boolean));
    return Array.from(set).sort();
  }, [conversations]);

  const openDetail = async (c: Conversation) => {
    setViewing(c);
    setPlayerTime(0);
    openIdRef.current = c.id;
    // VAPI's stored recording URL is a private, expiring path — fetch a fresh
    // playable (presigned) URL on open.
    setRecordingUrl(null);
    if (c.recording_url || c.stereo_recording_url) {
      api.getConversationRecordingUrl(c.id).then(({ data }) => {
        if (openIdRef.current === c.id) setRecordingUrl((data as any)?.url ?? null);
      });
    }
    // Lazy-load the structured transcript + recording URLs (kept out of the list payload).
    if (!c.transcript_messages || c.transcript_messages.length === 0) {
      setDetailLoading(true);
      const { data } = await api.getConversationTranscript(c.id);
      if (openIdRef.current !== c.id) return; // a different row was opened meanwhile
      if (data) {
        setViewing((v) =>
          v && v.id === c.id
            ? {
                ...v,
                transcript: (data as any).transcript ?? v.transcript,
                transcript_messages: (data as any).transcript_messages ?? v.transcript_messages,
                recording_url: (data as any).recording_url ?? v.recording_url,
                stereo_recording_url: (data as any).stereo_recording_url ?? v.stereo_recording_url,
                ai_summary: (data as any).ai_summary ?? v.ai_summary,
              }
            : v
        );
      }
      setDetailLoading(false);
    }
  };

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [convRes, statsRes] = await Promise.all([
      api.getConversations(),
      api.getConversationStats(),
    ]);
    if (convRes.data) {
      setConversations(Array.isArray(convRes.data) ? convRes.data : []);
    }
    if (statsRes.data) {
      const s = statsRes.data as any;
      setStats([
        { label: "Total", count: s.total ?? 0 },
        { label: "Completed", count: s.completed ?? 0 },
        { label: "Failed", count: s.failed ?? 0 },
        { label: "In Progress", count: s.in_progress ?? 0 },
        { label: "Qualified", count: s.qualified ?? 0 },
        { label: "Inbound", count: s.inbound ?? 0 },
        { label: "Outbound", count: s.outbound ?? 0 },
      ]);
    }
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => {
    load();
    // Silently refresh so calls synced in the background appear without a manual reload.
    const t = setInterval(() => load(true), 30000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">All Conversations</h1>
        <p className="text-sm text-muted-foreground">Every voice, SMS, WhatsApp and web chat in one place.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {stats.map((s) => (
          <div key={s.label} className="rounded-xl border border-border bg-card p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{s.label}</div>
            <div className="mt-1 text-2xl font-bold text-foreground">{s.count.toLocaleString()}</div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-center text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <tr className="divide-x divide-border">
              {COLUMNS.map(({ key, label, width }) => (
                <th key={key} className={`px-4 py-3 ${width ?? ""}`}>
                  <button
                    type="button"
                    onClick={() => toggleSort(key)}
                    className="flex w-full items-center justify-between gap-1 hover:text-foreground"
                  >
                    <span>{label}</span>
                    {sortKey === key ? (
                      sortDir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />
                    ) : (
                      <ArrowUpDown className="h-3 w-3 shrink-0 opacity-50" />
                    )}
                  </button>
                </th>
              ))}
              <th className="px-4 py-3 w-20">Actions</th>
            </tr>
            <tr className="divide-x divide-border border-t border-border">
              {COLUMNS.map(({ key, label, width }) =>
                key === "call_time" ? (
                  <th key={key} className={`px-4 py-3 font-normal normal-case ${width ?? ""}`}>
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-xs text-muted-foreground hover:bg-muted"
                        >
                          <CalendarIcon className="h-3 w-3 shrink-0" />
                          <span className="flex-1 truncate">{dateFilter ? format(dateFilter, "MMM d, yyyy") : "Date"}</span>
                          {dateFilter && (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={(e) => { e.stopPropagation(); setDateFilter(undefined); }}
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
                          selected={dateFilter}
                          onSelect={setDateFilter}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                  </th>
                ) : key === "status" ? (
                  <th key={key} className={`px-4 py-3 font-normal normal-case ${width ?? ""}`}>
                    <Select
                      value={filters.status || "__all__"}
                      onValueChange={(v) => setFilter("status", v === "__all__" ? "" : v)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Status" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All</SelectItem>
                        {statusOptions.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </th>
                ) : key === "qualified" ? (
                  <th key={key} className={`px-4 py-3 font-normal normal-case ${width ?? ""}`}>
                    <Select
                      value={filters.qualified || "__all__"}
                      onValueChange={(v) => setFilter("qualified", v === "__all__" ? "" : v)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Qualified" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">All</SelectItem>
                        <SelectItem value="yes">Qualified</SelectItem>
                        <SelectItem value="no">Not qualified</SelectItem>
                      </SelectContent>
                    </Select>
                  </th>
                ) : (
                  <th key={key} className={`px-4 py-3 font-normal normal-case ${width ?? ""}`}>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={filters[key]}
                        onChange={(e) => setFilter(key, e.target.value)}
                        placeholder={label}
                        className="h-8 pl-7 text-xs"
                      />
                    </div>
                  </th>
                )
              )}
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            ) : visibleConversations.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {conversations.length === 0 ? "No conversations found." : "No conversations match your filters."}
                </td>
              </tr>
            ) : (
              visibleConversations.map((c) => (
                <tr key={c.id} className="divide-x divide-border border-t border-border bg-card/30">
                  <td className="px-4 py-3 text-center">{c.channel}</td>
                  <td className="px-4 py-3 text-center font-medium text-foreground">{c.contact_name}</td>
                  <td className="px-4 py-3 text-center text-muted-foreground">{c.phone}</td>
                  <td className="px-4 py-3 text-center font-mono text-xs">{c.duration}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colorFor(c.status)}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {c.qualified ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">Qualified</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-center text-muted-foreground">{formatCallTime(c.call_time)}</td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => openDetail(c)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label="View"
                      title="View"
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Conversation · {viewing?.contact_name}</DialogTitle>
            <DialogDescription>{viewing?.channel} · {viewing ? formatCallTime(viewing.call_time) : ""}</DialogDescription>
          </DialogHeader>
          {viewing && (
            <div className="space-y-4">
              {/* Recording */}
              {(viewing.recording_url || viewing.stereo_recording_url) && recordingUrl === null ? (
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

              {/* Metadata */}
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div><div className="text-xs text-muted-foreground">Phone</div><div className="font-mono">{viewing.phone || "—"}</div></div>
                <div><div className="text-xs text-muted-foreground">Duration</div><div className="font-mono">{viewing.duration || "—"}</div></div>
                <div><div className="text-xs text-muted-foreground">Direction</div><div className="capitalize">{viewing.direction}</div></div>
                <div><div className="text-xs text-muted-foreground">Status</div><div>{viewing.status}</div></div>
                <div><div className="text-xs text-muted-foreground">Qualified</div><div>{viewing.qualified ? "Yes" : "No"}</div></div>
                {viewing.transferred_to && (
                  <div className="col-span-2 sm:col-span-3"><div className="text-xs text-muted-foreground">Transferred to</div><div className="font-mono">{viewing.transferred_to}</div></div>
                )}
              </div>

              {viewing.ai_summary && (
                <div>
                  <div className="mb-1 text-sm font-semibold">AI Summary</div>
                  <div className="rounded-md bg-muted/50 p-3 text-xs leading-relaxed">{viewing.ai_summary}</div>
                </div>
              )}

              {/* Transcript */}
              <div>
                <div className="mb-2 text-sm font-semibold">Transcript</div>
                {detailLoading ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript…
                  </div>
                ) : (
                  <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-muted/20 p-3">
                    <CallTranscript
                      messages={viewing.transcript_messages}
                      transcript={viewing.transcript}
                      activeTime={playerTime}
                      onSeek={(s) => playerRef.current?.seek(s)}
                    />
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Conversations;
