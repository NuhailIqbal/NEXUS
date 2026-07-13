import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
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
  recording_url: string | null;
  ai_summary: string | null;
  direction: string;
};

type StatItem = { label: string; count: number };

const Conversations = () => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [stats, setStats] = useState<StatItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<Conversation | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
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
      setLoading(false);
    };
    load();
  }, []);

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
                      onClick={() => setViewing(c)}
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
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Conversation · {viewing?.contact_name}</DialogTitle>
            <DialogDescription>{viewing?.channel} · {viewing?.call_time}</DialogDescription>
          </DialogHeader>
          {viewing && (
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <dt className="text-muted-foreground">Phone</dt>
              <dd className="col-span-2 font-mono">{viewing.phone}</dd>
              <dt className="text-muted-foreground">Duration</dt>
              <dd className="col-span-2 font-mono">{viewing.duration}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="col-span-2">{viewing.status}</dd>
              <dt className="text-muted-foreground">Conversion</dt>
              <dd className="col-span-2">{viewing.conversion}</dd>
              <dt className="text-muted-foreground">Qualified</dt>
              <dd className="col-span-2">{viewing.qualified ? "Yes" : "No"}</dd>
              {viewing.transferred_to && (
                <>
                  <dt className="text-muted-foreground">Transferred to</dt>
                  <dd className="col-span-2 font-mono">{viewing.transferred_to}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Direction</dt>
              <dd className="col-span-2">{viewing.direction}</dd>
              <dt className="text-muted-foreground">Recording</dt>
              <dd className="col-span-2">{viewing.recording_url ? <a href={viewing.recording_url} target="_blank" rel="noreferrer" className="text-primary underline">Play Recording</a> : "---"}</dd>
              {viewing.ai_summary && (
                <>
                  <dt className="text-muted-foreground col-span-3 mt-2 font-semibold">AI Summary</dt>
                  <dd className="col-span-3 rounded-md bg-muted/50 p-3 text-xs leading-relaxed">{viewing.ai_summary}</dd>
                </>
              )}
              {viewing.transcript && (
                <>
                  <dt className="text-muted-foreground col-span-3 mt-2 font-semibold">Transcript</dt>
                  <dd className="col-span-3 max-h-48 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs leading-relaxed whitespace-pre-wrap">{viewing.transcript}</dd>
                </>
              )}
            </dl>
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
