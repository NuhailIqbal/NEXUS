import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Bot, User, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
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
};

type Msg = { role: "user" | "assistant"; content: string };

const LANG_MAP: Record<string, string> = {
  "English (US)": "en-US",
  "English (UK)": "en-GB",
  "Spanish (ES)": "es-ES",
  "Spanish (MX)": "es-MX",
  "French (FR)": "fr-FR",
  "Italian (IT)": "it-IT",
  "German (DE)": "de-DE",
};

const FEMALE_HINTS = [
  "female", "woman", "samantha", "victoria", "karen", "tessa", "moira",
  "fiona", "veena", "zira", "susan", "allison", "ava", "serena", "aria",
  "nora", "eva", "lia",
];
const MALE_HINTS = [
  "male", "man", "daniel", "alex", "fred", "tom", "diego", "jorge",
  "david", "mark", "rishi", "oliver", "kai", "marco",
];

function pickVoice(agent: VoiceAgentInfo, langCode: string): SpeechSynthesisVoice | null {
  if (typeof window === "undefined") return null;
  const all = window.speechSynthesis.getVoices();
  if (!all.length) return null;
  const name = (agent.voice ?? "").toLowerCase();
  const isFemale = FEMALE_HINTS.some((h) => name.includes(h));
  const isMale = MALE_HINTS.some((h) => name.includes(h));
  const langMatches = all.filter(
    (v) => v.lang === langCode || v.lang.startsWith(langCode.split("-")[0]),
  );
  const pool = langMatches.length ? langMatches : all;
  const byHint = (hints: string[]) =>
    pool.find((v) => hints.some((h) => v.name.toLowerCase().includes(h)));
  if (isFemale) return byHint(FEMALE_HINTS) ?? pool[0] ?? null;
  if (isMale) return byHint(MALE_HINTS) ?? pool[0] ?? null;
  const byName = name ? pool.find((v) => v.name.toLowerCase().includes(name)) : null;
  return byName ?? pool[0] ?? null;
}

export function LiveVoiceModal({
  agent,
  open,
  onOpenChange,
}: {
  agent: VoiceAgentInfo | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(true);
  const recogRef = useRef<any>(null);
  const messagesRef = useRef<Msg[]>([]);
  const wantListenRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  messagesRef.current = messages;

  const langCode =
    (agent?.language && LANG_MAP[agent.language]) || "en-US";

  const stopAll = () => {
    wantListenRef.current = false;
    try {
      recogRef.current?.stop();
    } catch {}
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setListening(false);
    setSpeaking(false);
    setInterim("");
  };

  // Speak text, then resume listening when done
  const speak = (text: string, onEnd?: () => void) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window) || !agent) {
      onEnd?.();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langCode;
    const v = pickVoice(agent, langCode);
    if (v) u.voice = v;
    const name = (agent.voice ?? "").toLowerCase();
    const isFemale = FEMALE_HINTS.some((h) => name.includes(h));
    const isMale = MALE_HINTS.some((h) => name.includes(h));
    u.pitch = isFemale ? 1.15 : isMale ? 0.85 : 1;
    u.rate = 1;
    u.onstart = () => setSpeaking(true);
    u.onend = () => {
      setSpeaking(false);
      onEnd?.();
    };
    u.onerror = () => {
      setSpeaking(false);
      onEnd?.();
    };
    window.speechSynthesis.speak(u);
  };

  const sendToAgent = async (userText: string) => {
    if (!agent) return;
    const next: Msg[] = [...messagesRef.current, { role: "user", content: userText }];
    setMessages(next);
    setThinking(true);
    try {
      const { data, error } = await supabase.functions.invoke("agent-chat", {
        body: { messages: next, agent },
      });
      if (error) throw error;
      const reply: string = data?.reply ?? "Sorry, I didn't catch that.";
      setMessages((m) => [...m, { role: "assistant", content: reply }]);
      setThinking(false);
      speak(reply, () => {
        if (wantListenRef.current) startListening();
      });
    } catch (e: any) {
      setThinking(false);
      toast.error(e?.message ?? "Agent error");
    }
  };

  const startListening = () => {
    const SR =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      toast.error("Speech recognition not supported in this browser. Try Chrome.");
      return;
    }
    if (speaking) return;
    try {
      window.speechSynthesis.cancel();
    } catch {}
    const recog = new SR();
    recog.lang = langCode;
    recog.interimResults = true;
    recog.continuous = false;
    recog.maxAlternatives = 1;
    recogRef.current = recog;
    setInterim("");

    recog.onstart = () => setListening(true);
    recog.onresult = (ev: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (interimText) setInterim(interimText);
      if (finalText) {
        setInterim("");
        sendToAgent(finalText.trim());
      }
    };
    recog.onerror = (e: any) => {
      setListening(false);
      if (e.error === "not-allowed") {
        toast.error("Microphone permission denied.");
        wantListenRef.current = false;
      }
    };
    recog.onend = () => {
      setListening(false);
      // If still wanting to listen and not speaking/thinking, restart
      if (wantListenRef.current && !speaking && !thinking) {
        try {
          recog.start();
        } catch {}
      }
    };
    try {
      recog.start();
    } catch {}
  };

  const toggleMic = () => {
    if (listening) {
      wantListenRef.current = false;
      try {
        recogRef.current?.stop();
      } catch {}
      setListening(false);
    } else {
      wantListenRef.current = true;
      startListening();
    }
  };

  // Initialize call when opened
  useEffect(() => {
    if (!open || !agent) return;
    // Warm up voices
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
    }
    const greeting = `Hi, I'm ${agent.name.split("—")[0].trim()}. I'm your ${agent.category ?? "AI assistant"}. How can I help you today?`;
    setMessages([{ role: "assistant", content: greeting }]);
    setInterim("");
    wantListenRef.current = true;
    setTimeout(() => {
      speak(greeting, () => {
        if (wantListenRef.current) startListening();
      });
    }, 200);
    return () => {
      stopAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent?.id]);

  // Autoscroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, interim, thinking]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) stopAll();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className={`absolute inline-flex h-full w-full rounded-full ${listening || speaking ? "animate-ping bg-primary/70" : "bg-muted"}`} />
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${listening || speaking ? "bg-primary" : "bg-muted-foreground"}`} />
            </span>
            Live call with {agent?.name}
          </DialogTitle>
          <DialogDescription>
            {speaking
              ? "Agent is speaking…"
              : thinking
                ? "Agent is thinking…"
                : listening
                  ? "Listening — just speak."
                  : "Tap the mic to talk."}
          </DialogDescription>
        </DialogHeader>

        {agent && (
          <>
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div>
                <span className="text-muted-foreground">Voice: </span>
                <span className="font-medium">{agent.voice ?? "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Language: </span>
                <span className="font-medium">{agent.language ?? "—"}</span>
              </div>
            </div>

            <div
              ref={scrollRef}
              className="h-72 overflow-y-auto rounded-lg border border-border bg-background p-3 space-y-3"
            >
              {messages.map((m, i) => (
                <div
                  key={i}
                  className={`flex gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  {m.role === "assistant" && (
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                      <Bot className="h-4 w-4" />
                    </div>
                  )}
                  <div
                    className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                      m.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
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
              {interim && (
                <div className="flex justify-end gap-2 opacity-70">
                  <div className="max-w-[75%] rounded-lg bg-primary/60 px-3 py-2 text-sm text-primary-foreground italic">
                    {interim}…
                  </div>
                </div>
              )}
              {thinking && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Agent is thinking…
                </div>
              )}
            </div>

            <div className="flex items-center justify-center gap-3 pt-2">
              <Button
                size="lg"
                onClick={toggleMic}
                disabled={!supported || speaking || thinking}
                className={`h-14 w-14 rounded-full p-0 ${listening ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/90"}`}
                title={listening ? "Mute" : "Speak"}
              >
                {listening ? <MicOff className="h-6 w-6" /> : <Mic className="h-6 w-6" />}
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => {
                  stopAll();
                  onOpenChange(false);
                }}
                className="h-14 w-14 rounded-full p-0"
                title="End call"
              >
                <PhoneOff className="h-6 w-6" />
              </Button>
            </div>
            {!supported && (
              <p className="text-center text-xs text-destructive">
                Live mic not supported here. Use Chrome or Edge for voice input.
              </p>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
