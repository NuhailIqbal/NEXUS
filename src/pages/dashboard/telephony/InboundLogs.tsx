import { useEffect, useState, useCallback } from "react";
import {
  PhoneIncoming, CheckCircle2, XCircle, Clock, Loader2,
  FileText, Play,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/services/api";

type CallLog = {
  id: string;
  status: string;
  duration?: number;
  call_time?: string;
  customer_number?: string;
  agent_id?: string;
  ai_summary?: string;
  transcript?: string;
  recording_url?: string;
  direction?: string;
  sentiment?: string;
};

type Agent = { id: string; name: string };

const InboundLogs = () => {
  const [logs, setLogs] = useState<CallLog[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<CallLog | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    const [cRes, aRes] = await Promise.all([
      api.getConversations("direction=inbound&limit=100"),
      api.getAgents(),
    ]);
    if (Array.isArray(cRes.data)) setLogs(cRes.data);
    if (Array.isArray(aRes.data)) setAgents(new Map(aRes.data.map((a: any) => [a.id, a])));
    setLoading(false);
  }, []);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const openDetail = async (log: CallLog) => {
    setDetail(log);
    if (!log.transcript && !log.ai_summary) {
      setDetailLoading(true);
      const { data } = await api.getConversationTranscript(log.id);
      if (data) {
        setDetail((d) => d ? { ...d, transcript: data.transcript, ai_summary: data.ai_summary } : d);
      }
      setDetailLoading(false);
    }
  };

  const completed = logs.filter((l) => l.status === "Completed").length;
  const failed = logs.filter((l) => l.status === "Failed").length;
  const totalDuration = logs.reduce((sum, l) => sum + (l.duration || 0), 0);

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

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-foreground">{logs.length}</div>
          <div className="text-xs text-muted-foreground">Total Calls</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-green-600">{completed}</div>
          <div className="text-xs text-muted-foreground">Completed</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-destructive">{failed}</div>
          <div className="text-xs text-muted-foreground">Failed</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-2xl font-bold text-foreground">{Math.round(totalDuration / 60)}m</div>
          <div className="text-xs text-muted-foreground">Total Talk Time</div>
        </div>
      </div>

      {/* Logs Table */}
      {logs.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center text-muted-foreground">
          No inbound calls recorded yet.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Caller</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Time</th>
                <th className="px-4 py-3">Summary</th>
                <th className="px-4 py-3 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {logs.map((c) => (
                <tr key={c.id} className="border-t border-border bg-card/30 hover:bg-muted/20 transition-colors">
                  <td className="px-4 py-3 font-medium text-foreground">
                    {c.customer_number || "Unknown"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.agent_id ? agents.get(c.agent_id)?.name ?? "—" : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      {c.status === "Completed" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                      ) : c.status === "Failed" ? (
                        <XCircle className="h-3.5 w-3.5 text-destructive" />
                      ) : (
                        <Clock className="h-3.5 w-3.5 text-yellow-500" />
                      )}
                      <Badge variant={
                        c.status === "Completed" ? "default" :
                        c.status === "Failed" ? "destructive" :
                        "secondary"
                      }>
                        {c.status}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.duration ? `${Math.round(c.duration)}s` : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.call_time ? new Date(c.call_time).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">
                    {c.ai_summary || "—"}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => openDetail(c)}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-primary"
                      title="View details"
                    >
                      <FileText className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Modal */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PhoneIncoming className="h-5 w-5 text-primary" />
              Call Details
            </DialogTitle>
            <DialogDescription>
              {detail?.customer_number || "Unknown caller"} &bull; {detail?.call_time ? new Date(detail.call_time).toLocaleString() : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Status</div>
                <div className="mt-1 font-medium">{detail?.status}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Duration</div>
                <div className="mt-1 font-medium">{detail?.duration ? `${Math.round(detail.duration)}s` : "—"}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Agent</div>
                <div className="mt-1 font-medium">{detail?.agent_id ? agents.get(detail.agent_id)?.name ?? "—" : "—"}</div>
              </div>
            </div>

            {detail?.ai_summary && (
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-1">AI Summary</h4>
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">{detail.ai_summary}</div>
              </div>
            )}

            {detail?.recording_url && (
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-1">Recording</h4>
                <audio controls className="w-full" src={detail.recording_url}>
                  Your browser does not support audio playback.
                </audio>
              </div>
            )}

            {detailLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading transcript...
              </div>
            ) : detail?.transcript ? (
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-1">Transcript</h4>
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap max-h-60 overflow-y-auto">
                  {detail.transcript}
                </div>
              </div>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default InboundLogs;
