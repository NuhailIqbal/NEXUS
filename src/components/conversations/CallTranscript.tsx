import { useEffect, useMemo, useRef } from "react";
import { Bot, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";

export type TranscriptMessage = {
  role: "assistant" | "user" | "tool" | "system" | string;
  text: string;
  at?: number;   // seconds from call start
  dur?: number;  // seconds
};

type Props = {
  messages?: TranscriptMessage[] | null;
  /** Flat "AI: ...\nUser: ..." string used when structured messages are absent. */
  transcript?: string | null;
  /** Current audio position (seconds) — highlights the active turn. */
  activeTime?: number;
  /** Called with a turn's start time when the user clicks it. */
  onSeek?: (seconds: number) => void;
  className?: string;
};

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

// Parse VAPI's flat transcript ("AI:"/"User:" prefixed) into turns when the
// structured messages array isn't available (older calls).
const parseFlat = (transcript: string): TranscriptMessage[] => {
  const turns: TranscriptMessage[] = [];
  const re = /(^|\n)\s*(AI|Assistant|Bot|User|Customer|Caller)\s*:\s*/gi;
  const parts: { role: string; start: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) {
    const label = m[2].toLowerCase();
    const role = label === "user" || label === "customer" || label === "caller" ? "user" : "assistant";
    parts.push({ role, start: m.index + m[0].length });
  }
  if (!parts.length) {
    return transcript.trim() ? [{ role: "assistant", text: transcript.trim() }] : [];
  }
  for (let i = 0; i < parts.length; i++) {
    const end = i + 1 < parts.length ? transcript.lastIndexOf("\n", parts[i + 1].start) : transcript.length;
    const text = transcript.slice(parts[i].start, end > parts[i].start ? end : undefined).trim();
    if (text) turns.push({ role: parts[i].role, text });
  }
  return turns;
};

const CallTranscript = ({ messages, transcript, activeTime = 0, onSeek, className }: Props) => {
  const turns = useMemo<TranscriptMessage[]>(() => {
    if (messages && messages.length) return messages.filter((m) => m.role !== "system");
    if (transcript) return parseFlat(transcript);
    return [];
  }, [messages, transcript]);

  // Which turn is "active" given the current playback time.
  const activeIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < turns.length; i++) {
      const at = turns[i].at;
      if (at === undefined) continue;
      if (at <= activeTime) idx = i;
      else break;
    }
    return idx;
  }, [turns, activeTime]);

  const activeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  if (!turns.length) {
    return <p className={cn("text-sm text-muted-foreground", className)}>No transcript available for this call.</p>;
  }

  return (
    <div className={cn("space-y-3", className)}>
      {turns.map((t, i) => {
        const isUser = t.role === "user";
        const isTool = t.role === "tool";
        const seekable = onSeek && t.at !== undefined;

        if (isTool) {
          return (
            <div key={i} className="flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                <Wrench className="h-3 w-3" /> {t.text || "Tool call"}
              </span>
            </div>
          );
        }

        return (
          <div
            key={i}
            ref={i === activeIdx ? activeRef : undefined}
            className={cn("flex flex-col", isUser ? "items-end" : "items-start")}
          >
            <div className={cn("mb-1 flex items-center gap-2 px-1 text-[11px]", isUser && "flex-row-reverse")}>
              <span className={cn("flex items-center gap-1.5 font-semibold", isUser ? "text-muted-foreground" : "text-primary")}>
                {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                {isUser ? "Caller" : "AI Agent"}
              </span>
              {t.at !== undefined && (
                <button
                  type="button"
                  onClick={() => seekable && onSeek!(t.at!)}
                  className={cn("font-mono tabular-nums text-muted-foreground", seekable && "hover:text-primary hover:underline")}
                  title={seekable ? "Jump to this moment" : undefined}
                  disabled={!seekable}
                >
                  {fmt(t.at)}
                </button>
              )}
            </div>
            <div
              onClick={() => seekable && onSeek!(t.at!)}
              className={cn(
                "max-w-[88%] rounded-2xl border px-4 py-2.5 text-sm leading-relaxed transition",
                isUser
                  ? "rounded-tr-sm border-primary/25 bg-primary/10 text-foreground"
                  : "rounded-tl-sm border-border bg-card text-foreground",
                i === activeIdx && "border-primary/60 ring-2 ring-primary/40",
                seekable && "cursor-pointer hover:border-primary/40"
              )}
            >
              {t.text}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default CallTranscript;
