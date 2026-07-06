import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Bot, User, Loader2, AlertTriangle, PhoneCall, RefreshCw } from "lucide-react";
import Vapi from "@vapi-ai/web";
import { toast } from "sonner";
import { api } from "@/services/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export type VoiceAgentInfo = {
  id: string;
  name: string;
  voice?: string | null;
  language?: string | null;
  category?: string | null;
  status?: string;
  vapi_assistant_id?: string | null;
};

export type LiveVoiceModalProps = {
  agent: VoiceAgentInfo | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAgentSynced?: (agentId: string, vapiAssistantId: string) => void;
};

type Msg = { role: "user" | "assistant"; content: string };
type CallStatus = "idle" | "connecting" | "ringing" | "in-call" | "ended" | "error";

const PUBLIC_KEY = ((import.meta as any).env?.VITE_VAPI_PUBLIC_KEY ?? "").trim();

export function LiveVoiceModal({
  agent,
  open,
  onOpenChange,
  onAgentSynced,
}: LiveVoiceModalProps) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<CallStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncedAssistantId, setSyncedAssistantId] = useState<string | null>(null);
  const vapiRef = useRef<Vapi | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const teardown = () => {
    try { vapiRef.current?.stop(); } catch {}
    vapiRef.current = null;
  };

  const startCall = async (assistantIdOverride?: string) => {
    if (!agent) return;
    if (!PUBLIC_KEY) {
      setError("VAPI public key is not configured. Set VITE_VAPI_PUBLIC_KEY in your .env file.");
      setStatus("error");
      return;
    }
    const assistantId = assistantIdOverride ?? syncedAssistantId ?? agent.vapi_assistant_id;
    if (!assistantId) {
      setError("This agent isn't linked to a VAPI assistant yet. It was likely created before VAPI was configured use the Sync button below to fix this.");
      setStatus("error");
      return;
    }

    setStatus("connecting");
    setError(null);
    setMessages([]);

    try {
      const vapi = new Vapi(PUBLIC_KEY);
      vapiRef.current = vapi;

      vapi.on("call-start", () => setStatus("in-call"));
      vapi.on("call-end", () => setStatus("ended"));
      vapi.on("speech-start", () => {/* user starts talking UI hint optional */});
      vapi.on("speech-end", () => {/* user stops talking */});
      vapi.on("message", (m: any) => {
        if (m?.type === "transcript" && m?.transcriptType === "final") {
          const role: "user" | "assistant" = m.role === "user" ? "user" : "assistant";
          const content: string = m.transcript ?? "";
          if (content.trim()) {
            setMessages((prev) => [...prev, { role, content }]);
          }
        }
      });
      vapi.on("error", (e: any) => {
        const msg = e?.error?.message ?? e?.message ?? "VAPI call error";
        setError(msg);
        setStatus("error");
      });

      await vapi.start(assistantId);
    } catch (e: any) {
      setError(e?.message ?? "Failed to start call");
      setStatus("error");
      teardown();
    }
  };

  const syncToVapi = async () => {
    if (!agent) return;
    setSyncing(true);
    setError(null);
    const result = await api.syncAgentVapi(agent.id);
    setSyncing(false);
    if (result.error || !result.data?.vapi_assistant_id) {
      setError(result.error ?? "Sync failed no assistant ID returned. Check your VAPI configuration.");
      setStatus("error");
      return;
    }
    const newId: string = result.data.vapi_assistant_id;
    setSyncedAssistantId(newId);
    onAgentSynced?.(agent.id, newId);
    toast.success("Agent synced to VAPI starting call…");
    await startCall(newId);
  };

  const endCall = () => {
    teardown();
    setStatus("ended");
  };

  const toggleMute = () => {
    const vapi = vapiRef.current;
    if (!vapi) return;
    try {
      const nextMuted = !muted;
      vapi.setMuted(nextMuted);
      setMuted(nextMuted);
    } catch (e) {
      // ignore
    }
  };

  // Reset state when modal closes; auto-start when it opens
  useEffect(() => {
    if (!open) {
      teardown();
      setStatus("idle");
      setMessages([]);
      setMuted(false);
      setError(null);
      setSyncedAssistantId(null);
      return;
    }
    // auto-start on open
    startCall();
    return () => { teardown(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.id]);

  // Autoscroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const statusLabel: Record<CallStatus, string> = {
    idle: "Ready",
    connecting: "Connecting to agent…",
    ringing: "Ringing…",
    "in-call": "In call just talk.",
    ended: "Call ended",
    error: error ?? "Something went wrong",
  };

  const isLive = status === "in-call";
  const isBusy = status === "connecting" || status === "ringing";
  const isNotLinked = status === "error" && !agent?.vapi_assistant_id && !syncedAssistantId;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) teardown();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full rounded-full ${isLive ? "animate-ping bg-primary/70" : "bg-muted"}`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isLive ? "bg-primary" : status === "error" ? "bg-destructive" : "bg-muted-foreground"}`} />
            </span>
            Talk to {agent?.name}
          </DialogTitle>
          <DialogDescription>{statusLabel[status]}</DialogDescription>
        </DialogHeader>

        {!agent ? null : (
          <>
            <div className="grid grid-cols-3 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div><span className="text-muted-foreground">Voice: </span><span className="font-medium">{agent.voice ?? " "}</span></div>
              <div><span className="text-muted-foreground">Language: </span><span className="font-medium">{agent.language ?? " "}</span></div>
              <div><span className="text-muted-foreground">Status: </span><span className="font-medium">{agent.status ?? " "}</span></div>
            </div>

            {status === "error" && (
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
                {isNotLinked && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={syncToVapi}
                    disabled={syncing}
                    className="self-start border-destructive/40 text-destructive hover:bg-destructive/10"
                  >
                    {syncing ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    )}
                    {syncing ? "Syncing…" : "Sync to VAPI"}
                  </Button>
                )}
              </div>
            )}

            <div
              ref={scrollRef}
              className="h-72 overflow-y-auto rounded-lg border border-border bg-background p-3 space-y-3"
            >
              {messages.length === 0 && status === "in-call" && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  Listening… say hello to start the conversation.
                </p>
              )}
              {messages.length === 0 && isBusy && (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {statusLabel[status]}
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "assistant" && (
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Bot className="h-4 w-4" />
                    </div>
                  )}
                  <div
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                      m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
                    }`}
                  >
                    {m.content}
                  </div>
                  {m.role === "user" && (
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <User className="h-4 w-4" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-center gap-3 pt-2">
              {(status === "idle" || status === "ended" || (status === "error" && !isNotLinked)) && (
                <Button
                  size="lg"
                  onClick={() => startCall()}
                  className="h-14 rounded-full bg-primary px-6 hover:bg-primary/90"
                  title="Start call"
                >
                  <PhoneCall className="mr-2 h-5 w-5" />
                  {status === "ended" || status === "error" ? "Call again" : "Start call"}
                </Button>
              )}
              {isLive && (
                <>
                  <Button
                    size="lg"
                    onClick={toggleMute}
                    variant={muted ? "default" : "outline"}
                    className="h-14 w-14 rounded-full p-0"
                    title={muted ? "Unmute" : "Mute"}
                  >
                    {muted ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
                  </Button>
                  <Button
                    size="lg"
                    variant="destructive"
                    onClick={endCall}
                    className="h-14 w-14 rounded-full p-0"
                    title="End call"
                  >
                    <PhoneOff className="h-6 w-6" />
                  </Button>
                </>
              )}
              {isBusy && (
                <Button size="lg" variant="outline" onClick={endCall} className="h-14 rounded-full px-6">
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              Live web call powered by VAPI. Uses your agent's real voice, model, and tools no phone number needed.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
