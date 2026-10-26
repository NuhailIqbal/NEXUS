import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Check, Bot, Phone, Rocket, Users, PhoneIncoming, PhoneOutgoing, BarChart3, Headphones,
  ArrowRight, Clock, PartyPopper, Sparkles, Lightbulb, Timer, ListChecks, type LucideIcon,
} from "lucide-react";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TrackKey = "outbound" | "inbound";
type StepKey = "agent" | "phone" | "contacts" | "campaign" | "outboundCall" | "receptionist" | "connected" | "inboundCall";

type Counts = { agents: number; numbers: number; contacts: number; campaigns: number; receptionists: number };

type Step = {
  key: StepKey;
  title: string;
  description: string;
  minutes: number;
  icon: LucideIcon;
  href: string;
  /** Short hints shown while this is the step to do next. */
  tips: string[];
  /** What the user already has, shown once the step is done. */
  doneText: (c: Counts) => string;
  /** Needed by both Outbound and Inbound, so it shows up in each track. */
  shared?: boolean;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const STEPS: Record<StepKey, Step> = {
  agent: {
    key: "agent", title: "Create your first AI agent", description: "Give it a voice, a script and a goal.",
    minutes: 5, icon: Bot, href: "/dashboard/ai-agents/create", shared: true,
    tips: ["Add your website or documents in the Knowledge step so it answers accurately.", "Use the Testing step to try a live call before you save."],
    doneText: (c) => `${plural(c.agents, "AI agent")} ready`,
  },
  phone: {
    key: "phone", title: "Get a phone number", description: "Buy or connect the number your calls go through.",
    minutes: 2, icon: Phone, href: "/dashboard/telephony/phone-numbers", shared: true,
    tips: ["Choose an area code close to the people you call.", "You can also connect your own carrier under Integrations."],
    doneText: (c) => `${plural(c.numbers, "phone number")} ready`,
  },
  contacts: {
    key: "contacts", title: "Add your contacts", description: "Import a list or add the people you want to call.",
    minutes: 3, icon: Users, href: "/dashboard/database/contacts",
    tips: ["Import a file or add contacts one by one.", "Group contacts into lists so a campaign can target them."],
    doneText: (c) => `${plural(c.contacts, "contact")} added`,
  },
  campaign: {
    key: "campaign", title: "Launch your first campaign", description: "Pick an agent, a number and a list, then start dialing.",
    minutes: 10, icon: Rocket, href: "/dashboard/telephony/campaigns",
    tips: ["Set calling hours so calls only go out at the right times.", "A pre-launch check confirms everything is ready before it dials."],
    doneText: (c) => `${plural(c.campaigns, "campaign")} created`,
  },
  outboundCall: {
    key: "outboundCall", title: "Review your first outbound calls", description: "Listen to recordings and read transcripts.",
    minutes: 3, icon: BarChart3, href: "/dashboard/telephony/outbound-logs",
    tips: ["Open a call to hear the recording and read the transcript."],
    doneText: () => "Outbound calls recorded",
  },
  receptionist: {
    key: "receptionist", title: "Set up an AI receptionist", description: "Choose the agent that answers incoming calls.",
    minutes: 5, icon: PhoneIncoming, href: "/dashboard/telephony/inbound",
    tips: ["Choose the agent that should answer.", "Set answering hours so callers outside them hear that you are closed."],
    doneText: (c) => `${plural(c.receptionists, "receptionist")} created`,
  },
  connected: {
    key: "connected", title: "Connect a number to it", description: "Callers reach your receptionist on this number.",
    minutes: 2, icon: Headphones, href: "/dashboard/telephony/inbound",
    tips: ["Attach a number you own to the receptionist.", "Anyone who dials it reaches your agent."],
    doneText: () => "Number connected",
  },
  inboundCall: {
    key: "inboundCall", title: "Review your first inbound calls", description: "See who called and how your agent handled it.",
    minutes: 3, icon: BarChart3, href: "/dashboard/telephony/inbound-logs",
    tips: ["Call your number yourself to try it out.", "Open a call to read the transcript."],
    doneText: () => "Inbound calls received",
  },
};

const TRACKS: Record<TrackKey, { label: string; tagline: string; icon: LucideIcon; steps: StepKey[] }> = {
  outbound: {
    label: "Outbound", tagline: "Call your leads and customers",
    icon: PhoneOutgoing, steps: ["agent", "phone", "contacts", "campaign", "outboundCall"],
  },
  inbound: {
    label: "Inbound", tagline: "Answer every call that comes in",
    icon: PhoneIncoming, steps: ["agent", "phone", "receptionist", "connected", "inboundCall"],
  },
};

const QuickSetup = () => {
  const [done, setDone] = useState<Record<StepKey, boolean> | null>(null);
  const [counts, setCounts] = useState<Counts>({ agents: 0, numbers: 0, contacts: 0, campaigns: 0, receptionists: 0 });
  const [picked, setPicked] = useState<TrackKey | null>(null);

  useEffect(() => {
    (async () => {
      const [agents, phones, contacts, camps, inbound, outCalls, inCalls] = await Promise.all([
        api.getAgents(),
        api.getPhoneNumbers(),
        api.getContacts(),
        api.getCampaigns(),
        api.getInboundQueues(),
        api.getConversations("direction=outbound&limit=1"),
        api.getConversations("direction=inbound&limit=1"),
      ]);
      const list = (r: { data?: unknown }) => (Array.isArray(r.data) ? (r.data as any[]) : []);
      const receptionists = list(inbound);
      setCounts({
        agents: list(agents).length,
        numbers: list(phones).length,
        contacts: list(contacts).length,
        campaigns: list(camps).length,
        receptionists: receptionists.length,
      });
      setDone({
        agent: list(agents).length > 0,
        phone: list(phones).length > 0,
        contacts: list(contacts).length > 0,
        campaign: list(camps).length > 0,
        outboundCall: list(outCalls).length > 0,
        receptionist: receptionists.length > 0,
        connected: receptionists.some((r) => !!r.phone_number_id),
        inboundCall: list(inCalls).length > 0,
      });
    })();
  }, []);

  const loading = done === null;
  const isDone = (k: StepKey) => !!done?.[k];
  const trackProgress = (t: TrackKey) => {
    const keys = TRACKS[t].steps;
    const n = keys.filter(isDone).length;
    return { n, total: keys.length, percent: Math.round((n / keys.length) * 100), complete: n === keys.length };
  };

  const outbound = trackProgress("outbound");
  const inbound = trackProgress("inbound");
  // Open on the track that still needs work: outbound first, inbound once outbound is finished.
  const autoTrack: TrackKey = !loading && outbound.complete && !inbound.complete ? "inbound" : "outbound";
  const track = picked ?? autoTrack;
  const other: TrackKey = track === "outbound" ? "inbound" : "outbound";
  const progress = track === "outbound" ? outbound : inbound;
  const stepKeys = TRACKS[track].steps;
  const currentKey = stepKeys.find((k) => !isDone(k));
  const current = currentKey ? STEPS[currentKey] : null;
  const minutesLeft = stepKeys.filter((k) => !isDone(k)).reduce((sum, k) => sum + STEPS[k].minutes, 0);

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/15 via-background to-background p-6 sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
        <div className="pointer-events-none absolute inset-0 opacity-[0.06] [background-image:radial-gradient(hsl(var(--foreground))_1px,transparent_1px)] [background-size:18px_18px]" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <div className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary sm:flex">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Quick Setup</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {loading
                  ? "Checking your progress…"
                  : outbound.complete && inbound.complete
                    ? "Calling is fully set up. Review anything below any time."
                    : "A few steps to get your AI agents making and answering calls."}
              </p>
              {!loading && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground">
                    <ListChecks className="h-3.5 w-3.5 text-primary" /> {progress.n} of {progress.total} {TRACKS[track].label.toLowerCase()} steps done
                  </span>
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-background/60 px-2.5 py-1 text-xs text-muted-foreground">
                    <Timer className="h-3.5 w-3.5 text-primary" />
                    {minutesLeft > 0 ? `About ${minutesLeft} min left` : "Nothing left to do"}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div className="hidden items-center md:flex" aria-hidden="true">
            {stepKeys.map((k, i) => {
              const Icon = STEPS[k].icon;
              const finished = !loading && isDone(k);
              const isCurrent = !loading && k === currentKey;
              return (
                <div key={k} className="flex items-center">
                  <div className={cn(
                    "flex h-11 w-11 items-center justify-center rounded-xl border transition",
                    finished && "border-primary bg-primary text-primary-foreground",
                    isCurrent && "border-primary bg-primary/10 text-primary ring-4 ring-primary/15",
                    !finished && !isCurrent && "border-border bg-background/60 text-muted-foreground",
                  )}>
                    {finished ? <Check className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                  </div>
                  {i < stepKeys.length - 1 && (
                    <div className={cn("h-0.5 w-6 lg:w-8", finished ? "bg-primary" : "bg-border")} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {(["outbound", "inbound"] as TrackKey[]).map((t) => {
          const meta = TRACKS[t];
          const p = t === "outbound" ? outbound : inbound;
          const selected = track === t;
          const Icon = meta.icon;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setPicked(t)}
              aria-pressed={selected}
              className={cn(
                "flex items-center gap-4 rounded-xl border p-4 text-left transition",
                selected
                  ? "border-primary bg-primary/5 shadow-sm ring-1 ring-primary/30"
                  : "border-border bg-card hover:border-primary/40",
              )}
            >
              <div className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
                selected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
              )}>
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground">{meta.label}</span>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                    !loading && p.complete ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                  )}>
                    {loading ? "…" : p.complete ? "Complete" : `${p.n}/${p.total} done`}
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">{meta.tagline}</p>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${loading ? 0 : p.percent}%` }} />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <aside className="space-y-4 lg:order-2 lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center gap-4">
              <ProgressRing percent={loading ? 0 : progress.percent} />
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">{TRACKS[track].label} setup</p>
                <p className="text-lg font-semibold text-foreground">
                  {loading ? "…" : `${progress.n} of ${progress.total} steps`}
                </p>
              </div>
            </div>

            {!loading && current && (
              <div className="mt-5 rounded-xl border border-primary/30 bg-primary/5 p-4">
                <p className="text-xs font-medium uppercase tracking-wide text-primary">Up next</p>
                <p className="mt-1 font-semibold text-foreground">{current.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{current.description}</p>
                <Button asChild className="mt-3 w-full">
                  <Link to={current.href}>Continue <ArrowRight className="ml-2 h-4 w-4" /></Link>
                </Button>
              </div>
            )}

            {!loading && !current && (
              <div className="mt-5 rounded-xl border border-success/30 bg-success/10 p-4">
                <div className="flex items-center gap-2 font-semibold text-foreground">
                  <PartyPopper className="h-4 w-4 text-success" /> {TRACKS[track].label} is ready
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {trackProgress(other).complete
                    ? "Both tracks are finished. Nice work."
                    : `Next, set up ${TRACKS[other].label.toLowerCase()} calls too.`}
                </p>
                {!trackProgress(other).complete && (
                  <Button variant="outline" className="mt-3 w-full" onClick={() => setPicked(other)}>
                    Set up {TRACKS[other].label} <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-foreground">Your account</h3>
            <dl className="mt-3 space-y-2 text-sm">
              <CountRow icon={Bot} label="AI agents" value={counts.agents} loading={loading} />
              <CountRow icon={Phone} label="Phone numbers" value={counts.numbers} loading={loading} />
              <CountRow icon={Users} label="Contacts" value={counts.contacts} loading={loading} />
              <CountRow icon={Rocket} label="Campaigns" value={counts.campaigns} loading={loading} />
              <CountRow icon={PhoneIncoming} label="Receptionists" value={counts.receptionists} loading={loading} />
            </dl>
          </div>
        </aside>

        <section className="lg:order-1">
          <h2 className="mb-4 text-lg font-semibold text-foreground">{TRACKS[track].label} checklist</h2>
          {loading ? (
            <div className="space-y-3">
              {stepKeys.map((k) => (
                <div key={k} className="h-[88px] animate-pulse rounded-xl border border-border bg-muted/30" />
              ))}
            </div>
          ) : (
            <ol className="space-y-3">
              {stepKeys.map((k, i) => {
                const step = STEPS[k];
                const Icon = step.icon;
                const finished = isDone(k);
                const isCurrent = k === currentKey;
                const last = i === stepKeys.length - 1;
                return (
                  <li
                    key={`${track}-${k}`}
                    className="relative flex gap-4 animate-in fade-in slide-in-from-bottom-2 duration-500 [animation-fill-mode:backwards]"
                    style={{ animationDelay: `${i * 70}ms` }}
                  >
                    <div className="relative flex flex-col items-center">
                      <div className={cn(
                        "z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold transition",
                        finished && "border-primary bg-primary text-primary-foreground",
                        isCurrent && "border-primary bg-background text-primary ring-4 ring-primary/15",
                        !finished && !isCurrent && "border-border bg-background text-muted-foreground",
                      )}>
                        {finished ? <Check className="h-4 w-4" /> : i + 1}
                      </div>
                      {!last && (
                        <div className={cn("w-0.5 flex-1", finished ? "bg-primary" : "bg-border")} />
                      )}
                    </div>

                    <Link
                      to={step.href}
                      className={cn(
                        "group mb-0 flex min-w-0 flex-1 items-center gap-4 rounded-xl border p-4 transition",
                        isCurrent && "border-primary/50 bg-primary/5 shadow-sm hover:border-primary",
                        finished && "border-border bg-card/60 hover:border-primary/40",
                        !finished && !isCurrent && "border-border bg-card hover:border-primary/40",
                      )}
                    >
                      <div className={cn(
                        "hidden h-11 w-11 shrink-0 items-center justify-center rounded-lg sm:flex",
                        finished ? "bg-success/15 text-success" : "bg-primary/10 text-primary",
                      )}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h3 className={cn("font-semibold", finished ? "text-muted-foreground" : "text-foreground")}>{step.title}</h3>
                          {step.shared && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              Both tracks
                            </span>
                          )}
                        </div>
                        <p className={cn("mt-0.5 text-sm", finished ? "font-medium text-success" : "text-muted-foreground")}>
                          {finished ? step.doneText(counts) : step.description}
                        </p>
                        {isCurrent && (
                          <ul className="mt-3 space-y-1.5">
                            {step.tips.map((tip) => (
                              <li key={tip} className="flex items-start gap-2 text-xs text-muted-foreground">
                                <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" /> <span>{tip}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {!finished && (
                          <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="h-3 w-3" /> {step.minutes} min
                          </div>
                        )}
                      </div>
                      <div className="shrink-0">
                        {finished ? (
                          <span className="rounded-full bg-success/15 px-2.5 py-1 text-xs font-medium text-success">Done</span>
                        ) : isCurrent ? (
                          <>
                            <span className="hidden items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground sm:inline-flex">
                              Start <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                            </span>
                            <ArrowRight className="h-5 w-5 text-primary sm:hidden" />
                          </>
                        ) : (
                          <ArrowRight className="h-4 w-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
};

function CountRow({ icon: Icon, label, value, loading }: { icon: LucideIcon; label: string; value: number; loading: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="flex items-center gap-2 text-muted-foreground"><Icon className="h-4 w-4" />{label}</dt>
      <dd className="font-semibold text-foreground">{loading ? "…" : value.toLocaleString()}</dd>
    </div>
  );
}

function ProgressRing({ percent }: { percent: number }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const offset = c - (percent / 100) * c;
  return (
    <div className="relative flex h-20 w-20 shrink-0 items-center justify-center">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90">
        <circle cx="40" cy="40" r={r} stroke="hsl(var(--muted))" strokeWidth="7" fill="none" />
        <circle
          cx="40" cy="40" r={r} stroke="hsl(var(--primary))" strokeWidth="7" fill="none"
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-lg font-bold leading-none text-foreground">{percent}%</div>
      </div>
    </div>
  );
}

export default QuickSetup;
