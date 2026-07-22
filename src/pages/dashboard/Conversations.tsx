import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { api } from "@/services/api";
import { Badge } from "@/components/ui/badge";
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
  conversion: string;
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
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Channel</th>
              <th className="px-4 py-3">Contact</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Conversion</th>
              <th className="px-4 py-3">Qualified</th>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            ) : conversations.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">No conversations found.</td>
              </tr>
            ) : (
              conversations.map((c) => (
                <tr key={c.id} className="border-t border-border bg-card/30">
                  <td className="px-4 py-3">{c.channel}</td>
                  <td className="px-4 py-3 font-medium text-foreground">{c.contact_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.phone}</td>
                  <td className="px-4 py-3 font-mono text-xs">{c.duration}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colorFor(c.status)}`}>{c.status}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={c.conversion === "Yes" ? "default" : "outline"}>{c.conversion}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {c.qualified ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">Qualified</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.call_time}</td>
                  <td className="px-4 py-3">
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
            <DialogDescription>{viewing?.channel} · {viewing?.call_time}</DialogDescription>
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
                <div><div className="text-xs text-muted-foreground">Conversion</div><div>{viewing.conversion}</div></div>
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
