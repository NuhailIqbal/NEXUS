/**
 * The round chat icon on every dashboard page (mounted once by DashboardLayout) that opens the NEXUS assistant:
 * an AI helper that answers how-to questions about the platform. It is not a person and cannot see the user's account;
 * the header says "AI assistant", its replies point to the support email for anything account-specific.
 *
 * Behaviour: the conversation lives in sessionStorage for the tab; the header has a small chevron (minimize, keeps the chat) and a cross (close and end the chat); the round icon only opens it and is hidden while the window is open; Enter sends and
 * Shift+Enter makes a new line; an empty chat offers one-tap starter questions; a small "Need help?" teaser shows once
 * per tab session after a few seconds (dismissible) so first-time users notice the icon. On phones the window fills the
 * screen. The Support page's chat card opens it through OPEN_SUPPORT_CHAT_EVENT.
 * API: api.supportChat (POST /support/chat, routers/support_chat.py).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, SendHorizontal, Sparkles, X } from "lucide-react";
import { api } from "@/services/api";

/** Window event that opens the chat window (used by the Support page). */
export const OPEN_SUPPORT_CHAT_EVENT = "nexus:open-support-chat";

const STORE = "nexus_support_chat";
const TEASER_SEEN = "nexus_support_chat_teaser";
const MAX_LEN = 1000;
const NAME = "NEXUS Assistant";
const TEASER_DELAY_MS = 4000;

/** One-tap starters shown while the chat is empty: the things new customers ask first. */
export const STARTERS = [
  "How do I create my first AI agent?",
  "How do I buy a phone number?",
  "How does billing work?",
  "How do I start a campaign?",
];

type Msg = { role: "user" | "assistant"; content: string; t: number };

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The assistant's avatar: a round brand-coloured badge with the AI sparkle mark, so it matches the chat icon and the theme.
 * In the header (`onPrimary`) the colours are inverted so it stands out on the coloured bar; `online` adds the green dot.
 */
function Avatar({ size = 32, online = false, onPrimary = false }: { size?: number; online?: boolean; onPrimary?: boolean }) {
  return (
    <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <span
        className={`flex h-full w-full items-center justify-center rounded-full shadow-sm ring-1 ${
          onPrimary
            ? "bg-primary-foreground text-primary ring-black/10"
            : "bg-gradient-to-br from-primary to-primary/60 text-primary-foreground ring-white/20"
        }`}
      >
        <Sparkles style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={2.2} />
      </span>
      {online && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-primary bg-emerald-400" />}
    </span>
  );
}

function load(): Msg[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(STORE) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

const SupportChatBubble = ({ firstName }: { firstName?: string }) => {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>(load);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [teaser, setTeaser] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-60))); } catch { /* storage may be unavailable */ }
  }, [msgs]);

  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener(OPEN_SUPPORT_CHAT_EVENT, openIt);
    return () => window.removeEventListener(OPEN_SUPPORT_CHAT_EVENT, openIt);
  }, []);

  // The teaser: once per tab session, only for someone who has not used the chat yet.
  useEffect(() => {
    let seen = false;
    try { seen = !!sessionStorage.getItem(TEASER_SEEN); } catch { /* ignore */ }
    if (seen || msgs.length > 0) return;
    const id = setTimeout(() => setTeaser(true), TEASER_DELAY_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismissTeaser = useCallback(() => {
    setTeaser(false);
    try { sessionStorage.setItem(TEASER_SEEN, "1"); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) { dismissTeaser(); inputRef.current?.focus(); }
  }, [open, dismissTeaser]);

  const toBottom = useCallback((smooth = false) => {
    const el = logRef.current;
    if (!el) return;
    if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => { toBottom(true); }, [msgs, busy, error, open, toBottom]);

  // Grow the box with the text, up to about four lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 104)}px`;
  }, [text, open]);

  const ask = useCallback(async (raw: string) => {
    const content = raw.trim();
    if (!content || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content, t: Date.now() }];
    setMsgs(next);
    setText("");
    setError(null);
    setBusy(true);
    const { data, error: err } = await api.supportChat(next.map(({ role, content: c }) => ({ role, content: c })));
    setBusy(false);
    if (err || !data?.reply) {
      setMsgs(next.slice(0, -1));          // the unanswered question is dropped, so a retry starts clean
      setText(content);
      setError(err || "Sorry, something went wrong. Please try again.");
      return;
    }
    setMsgs([...next, { role: "assistant", content: data.reply, t: Date.now() }]);
  }, [msgs, busy]);

  const endChat = () => {
    if (busy) return;
    setMsgs([]);
    setError(null);
    setStartedAt(Date.now());
    setOpen(false);
  };

  const welcome = `Hi${firstName ? ` ${firstName}` : ""}! I'm the NEXUS assistant. Ask me how to set up agents, phone numbers, campaigns or billing. I'm an AI, so I can't see your account.`;
  const rows: Msg[] = [{ role: "assistant", content: welcome, t: startedAt }, ...msgs];

  return (
    <div className="fixed bottom-4 right-4 z-40 sm:bottom-6 sm:right-6">
      {open && (
        <section
          role="dialog"
          aria-label={NAME}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-card sm:absolute sm:inset-auto sm:bottom-0 sm:right-0 sm:h-[min(600px,calc(100vh-120px))] sm:w-[390px] sm:rounded-2xl sm:border sm:border-border sm:shadow-2xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:slide-in-from-bottom-2"
        >
          <header className="flex items-center gap-3 bg-gradient-to-br from-primary to-primary/80 px-4 py-3.5 text-primary-foreground">
            <Avatar size={40} online onPrimary />
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-[15px] font-semibold">{NAME}</p>
              <p className="truncate text-xs opacity-80">AI assistant · replies instantly</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Minimize chat" title="Minimize (keeps the chat)" className="rounded-full p-1.5 opacity-80 transition hover:bg-black/10 hover:opacity-100">
              <ChevronDown className="h-5 w-5" />
            </button>
            <button type="button" onClick={endChat} aria-label="End chat" title="Close and end the chat" className="rounded-full p-1.5 opacity-80 transition hover:bg-black/10 hover:opacity-100">
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="relative min-h-0 flex-1">
            <div
              ref={logRef}
              role="log"
              aria-live="polite"
              onScroll={(e) => { const el = e.currentTarget; setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48); }}
              className="flex h-full flex-col gap-1 overflow-y-auto bg-background px-4 py-4"
            >
              <div className="mb-3 flex items-center gap-3 text-xs font-medium text-muted-foreground">
                <span className="h-px flex-1 bg-border" />Today<span className="h-px flex-1 bg-border" />
              </div>

              {rows.map((m, i) => {
                const prev = rows[i - 1];
                const next = rows[i + 1];
                const firstOfGroup = !prev || prev.role !== m.role;
                const lastOfGroup = !next || next.role !== m.role;
                return <Bubble key={i} msg={m} firstOfGroup={firstOfGroup} lastOfGroup={lastOfGroup} />;
              })}

              {msgs.length === 0 && (
                <div className="mt-3 flex flex-wrap gap-2 pl-10" aria-label="Suggested questions">
                  {STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => ask(s)}
                      className="rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-left text-[13px] text-foreground transition hover:border-primary hover:bg-primary/10"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}

              {busy && (
                <div className="mt-2 flex items-end gap-2" aria-label="The assistant is typing">
                  <Avatar size={28} />
                  <div className="flex gap-1 rounded-2xl rounded-bl-md bg-card px-4 py-3 shadow-sm ring-1 ring-border">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="h-2 w-2 rounded-full bg-muted-foreground/70 motion-safe:animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              )}
              {error && <p role="alert" className="mt-2 self-center rounded-lg bg-destructive/10 px-3 py-2 text-center text-sm text-destructive">{error}</p>}
            </div>

            {!atBottom && (
              <button
                type="button"
                onClick={() => toBottom(true)}
                aria-label="Scroll to the latest message"
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card p-1.5 shadow-md hover:bg-muted"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            )}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); ask(text); }}
            className="border-t border-border bg-card px-3 py-3"
          >
            <div className="flex items-end gap-2 rounded-2xl border border-input bg-background px-3 py-1.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25">
              <textarea
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(text); } }}
                maxLength={MAX_LEN}
                rows={1}
                placeholder="Write a message…"
                aria-label="Your message"
                className="max-h-[104px] min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <button
                type="submit"
                disabled={busy || !text.trim()}
                aria-label="Send"
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition enabled:hover:scale-105 disabled:opacity-35"
              >
                <SendHorizontal className="h-4 w-4" />
              </button>
            </div>
          </form>
        </section>
      )}

      {teaser && !open && (
        <div className="absolute bottom-[72px] right-0 w-max max-w-[min(260px,calc(100vw-2rem))] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2">
          <div className="relative rounded-2xl rounded-br-md border border-border bg-card px-4 py-3 pr-8 text-sm text-foreground shadow-xl">
            <button type="button" onClick={dismissTeaser} aria-label="Dismiss" className="absolute right-2 top-2 rounded-full p-0.5 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => setOpen(true)} className="text-left">
              <span className="block font-semibold">Need a hand?</span>
              <span className="block text-muted-foreground">Ask me anything about NEXUS.</span>
            </button>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open chat"
        className={`${open ? "hidden" : "flex"} relative h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/80 text-primary-foreground shadow-xl ring-1 ring-black/5 transition-transform hover:scale-105 active:scale-95`}
      >
        {!open && msgs.length === 0 && <span className="absolute inset-0 -z-10 rounded-full bg-primary/40 motion-safe:animate-ping" aria-hidden="true" />}
        <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2C6.48 2 2 5.9 2 10.7c0 2.4 1.1 4.6 3 6.2V21l3.9-2.1c.97.27 2 .4 3.1.4 5.52 0 10-3.9 10-8.7S17.52 2 12 2z" />
          <circle cx="7.5" cy="10.7" r="1.3" className="fill-primary" />
          <circle cx="12" cy="10.7" r="1.3" className="fill-primary" />
          <circle cx="16.5" cy="10.7" r="1.3" className="fill-primary" />
        </svg>
      </button>
    </div>
  );
};

/**
 * One message. Messages from the same side stack closely; the assistant's group has the avatar beside its last
 * message and the time under it, the user's sit on the right in the brand colour. Plain text only.
 */
function Bubble({ msg, firstOfGroup, lastOfGroup }: { msg: Msg; firstOfGroup: boolean; lastOfGroup: boolean }) {
  const mine = msg.role === "user";
  const gap = firstOfGroup ? "mt-3" : "mt-0.5";
  if (mine) {
    return (
      <div className={`flex flex-col items-end ${gap}`}>
        <p className={`min-w-0 max-w-[82%] whitespace-pre-wrap break-words rounded-2xl bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground ${lastOfGroup ? "rounded-br-md" : ""}`}>{msg.content}</p>
        {lastOfGroup && <span className="mt-1 pr-1 text-[11px] text-muted-foreground">{clock(msg.t)}</span>}
      </div>
    );
  }
  return (
    <div className={`flex items-end gap-2 ${gap}`}>
      <span className="w-7 shrink-0">{lastOfGroup && <Avatar size={28} />}</span>
      <div className="min-w-0 max-w-[82%]">
        <p className={`whitespace-pre-wrap break-words rounded-2xl bg-card px-3.5 py-2 text-sm leading-relaxed text-foreground shadow-sm ring-1 ring-border ${lastOfGroup ? "rounded-bl-md" : ""}`}>{msg.content}</p>
        {lastOfGroup && <span className="mt-1 block pl-1 text-[11px] text-muted-foreground">{NAME} · {clock(msg.t)}</span>}
      </div>
    </div>
  );
}

export default SupportChatBubble;
