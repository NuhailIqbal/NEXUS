import { useEffect, useMemo, useState } from "react";
import {
  X, Rocket, Mic, Phone, Clipboard, Clock, Users, GitBranch, Target,
  SlidersHorizontal, PhoneCall, Shuffle, BookOpen, RefreshCw, Moon,
  ChevronLeft, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: CampaignData) => void;
};

type CampaignData = {
  name: string;
  description: string;
  voipProvider: string;
  agents: string[];
  answerTimeout: number;
  maxAttempts: number;
  maxAgents: number;
  actions: string[];
  strategy: string;
  customerList: string;
  reschedule: {
    noAnswer: { retry: number; interval: string };
    rejected: { retry: number; interval: string };
    busy: { retry: number; interval: string };
  };
  googleSync: boolean;
  active: boolean;
};

const VOIP_PROVIDERS = [
  { id: "outbound-idt", name: "Outbound IDT", connected: true },
  { id: "idt", name: "IDT", connected: true },
];

const STATIC_AGENT_OPTIONS = [
  "Med Alert", "U65 Health Insurance", "HVAC (Outbound)", "Solar Installation",
  "Solar Cancellation", "Bathroom", "Debt Settlement", "MVA",
];

const ACTION_OPTIONS = ["Send SMS", "Send Email", "Update CRM", "Webhook", "Schedule Callback", "Voicemail Drop"];

const STRATEGIES = [
  { id: "priority", name: "Priority Based", desc: "Call high-priority contacts first with more attempts", icon: SlidersHorizontal },
  { id: "max", name: "Maximum Attempts", desc: "Prioritize contact success over volume", icon: PhoneCall },
  { id: "min", name: "Minimum Attempts", desc: "Focus on reaching maximum contacts with fewer attempts", icon: Target },
  { id: "random", name: "Random Strategy", desc: "Randomly distribute calls across all contacts for unbiased outreach", icon: Shuffle },
];

const CUSTOMER_LISTS = ["No Answer SMS Flow Customers", "All Leads", "Q2 Cold Outreach", "Webinar Attendees"];

const STEPS = [
  { title: "Campaign Basics", subtitle: "Name, provider, agent, and priority" },
  { title: "Call Settings", subtitle: "Timeout, attempts, active agents, actions & strategy" },
  { title: "Customer List & Reschedule", subtitle: "Select customers and configure reschedule rules" },
  { title: "Review & Launch", subtitle: "Review all details and launch your campaign" },
];

const ATTEMPT_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const AGENT_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30];
const INTERVALS = ["", "5", "10", "15", "30", "60", "120"];

export function CreateCampaignDialog({ open, onOpenChange, onCreate }: Props) {
  const [agentOptions, setAgentOptions] = useState<string[]>(STATIC_AGENT_OPTIONS);

  useEffect(() => {
    api.getAgents().then(({ data }) => {
      if (data && Array.isArray(data)) {
        const names = data.map((a: any) => a.name).filter(Boolean);
        setAgentOptions([...STATIC_AGENT_OPTIONS, ...names]);
      }
    });
  }, []);

  const [step, setStep] = useState(0);
  const [data, setData] = useState<CampaignData>({
    name: "", description: "", voipProvider: "outbound-idt", agents: [],
    answerTimeout: 30, maxAttempts: 1, maxAgents: 10, actions: [],
    strategy: "random", customerList: CUSTOMER_LISTS[0],
    reschedule: { noAnswer: { retry: 0, interval: "" }, rejected: { retry: 0, interval: "" }, busy: { retry: 0, interval: "" } },
    googleSync: false, active: true,
  });

  const update = <K extends keyof CampaignData>(key: K, value: CampaignData[K]) => setData((d) => ({ ...d, [key]: value }));

  const reset = () => {
    setStep(0);
    setData({
      name: "", description: "", voipProvider: "outbound-idt", agents: [],
      answerTimeout: 30, maxAttempts: 1, maxAgents: 10, actions: [],
      strategy: "random", customerList: CUSTOMER_LISTS[0],
      reschedule: { noAnswer: { retry: 0, interval: "" }, rejected: { retry: 0, interval: "" }, busy: { retry: 0, interval: "" } },
      googleSync: false, active: true,
    });
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const progress = ((step + 1) / STEPS.length) * 100;

  const next = () => {
    if (step === 0) {
      if (!data.name.trim()) return toast.error("Queue name is required");
      if (data.agents.length === 0) return toast.error("Select at least one agent");
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const back = () => setStep((s) => Math.max(s - 1, 0));

  const launch = () => {
    onCreate?.(data);
    toast.success(`Campaign "${data.name}" launched`);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0 sm:rounded-xl [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Create Outbound Campaign</DialogTitle>
          <DialogDescription>Configure and launch an outbound dialing campaign in 4 steps.</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow">
              <Rocket className="h-5 w-5" />
            </div>
            <div className="text-xl font-bold tracking-tight">
              Create <span className="text-primary">Outbound Campaign</span>
              <span className="ml-1 text-sm font-normal text-muted-foreground">Step {step + 1} of {STEPS.length}</span>
            </div>
          </div>
          <button onClick={() => close(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-border bg-primary/5 px-6 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-base font-semibold">{STEPS[step].title}</h3>
            <span className="text-sm font-medium text-muted-foreground">{Math.round(progress)}% Complete</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{STEPS[step].subtitle}</p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-6">
          {step === 0 && <Step1 data={data} update={update} agentOptions={agentOptions} />}
          {step === 1 && <Step2 data={data} update={update} />}
          {step === 2 && <Step3 data={data} update={update} />}
          {step === 3 && <Step4 data={data} update={update} />}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-card px-6 py-4">
          <Button variant="outline" onClick={back} disabled={step === 0}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={next} className="bg-primary text-primary-foreground hover:opacity-90">
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={launch} className="bg-primary text-primary-foreground hover:opacity-90">
              <Rocket className="mr-1.5 h-4 w-4" /> Launch Campaign
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Step1({ data, update, agentOptions }: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void; agentOptions: string[] }) {
  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Information">
        <Field label="Queue Name" required>
          <Input value={data.name} onChange={(e) => update("name", e.target.value)} placeholder="Please provide your queue name" />
        </Field>
        <Field label="Queue Description" hint="Optional: Provide details about your campaign objectives">
          <Textarea value={data.description} onChange={(e) => update("description", e.target.value)} placeholder="Queue Description" rows={4} />
        </Field>
      </Section>

      <Section icon={Phone} title="VoIP Provider">
        <div className="mb-2 text-sm font-semibold">Select your VoIP provider <span className="text-destructive">*</span></div>
        <div className="grid gap-3 sm:grid-cols-2">
          {VOIP_PROVIDERS.map((p) => {
            const selected = data.voipProvider === p.id;
            return (
              <button key={p.id} type="button" onClick={() => update("voipProvider", p.id)} className={`rounded-lg border p-4 text-left transition ${selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{p.name}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Ready to use for campaigns</div>
                  </div>
                  <span className="rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">connected</span>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={Clipboard} title="AI Agent Selection">
        <p className="mb-3 text-sm text-muted-foreground">Choose the AI agent that will handle your campaign calls</p>
        <Field label="Agents" required>
          <MultiSelect options={agentOptions} value={data.agents} onChange={(v) => update("agents", v)} placeholder="Select up to 15 Options..." max={15} />
        </Field>
      </Section>
    </div>
  );
}

function Step2({ data, update }: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void }) {
  return (
    <div className="space-y-6">
      <Section icon={Clock} title="Call Timing Settings">
        <p className="mb-4 text-sm text-muted-foreground">Configure how long to wait and how many times to attempt contact</p>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-semibold">Answer Timeout: {data.answerTimeout} seconds</div>
            <input type="range" min={10} max={120} value={data.answerTimeout} onChange={(e) => update("answerTimeout", Number(e.target.value))} className="w-full accent-primary" />
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>10s</span>
              <span>120s</span>
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold">Maximum Contact Attempts: {data.maxAttempts}</div>
            <div className="flex flex-wrap gap-2">
              {ATTEMPT_NUMS.map((n) => (<PillNum key={n} n={n} active={data.maxAttempts === n} onClick={() => update("maxAttempts", n)} />))}
            </div>
          </div>
        </div>
      </Section>

      <Section icon={Users} title="Active Agents">
        <p className="mb-4 text-sm text-muted-foreground">Select how many agents are allowed to talk at the same time</p>
        <div className="mb-2 text-sm font-semibold">Maximum Active Agents: {data.maxAgents}</div>
        <div className="flex flex-wrap gap-2">
          {AGENT_NUMS.map((n) => (<PillNum key={n} n={n} active={data.maxAgents === n} onClick={() => update("maxAgents", n)} />))}
        </div>
      </Section>

      <Section icon={GitBranch} title="Actions Selection">
        <Field label="Actions">
          <MultiSelect options={ACTION_OPTIONS} value={data.actions} onChange={(v) => update("actions", v)} placeholder="Select up to 15 Options..." max={15} />
        </Field>
      </Section>

      <Section icon={Target} title="Call Strategy">
        <p className="mb-4 text-sm text-muted-foreground">Choose how your dialer should prioritize and distribute calls</p>
        <div className="space-y-2">
          {STRATEGIES.map((s) => {
            const selected = data.strategy === s.id;
            return (
              <button key={s.id} type="button" onClick={() => update("strategy", s.id)} className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}>
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <s.icon className="h-4 w-4" />
                </div>
                <div className="flex-1">
                  <div className="font-semibold">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.desc}</div>
                </div>
                {selected && <span className="rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">Selected</span>}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function Step3({ data, update }: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void }) {
  const setRule = (key: keyof CampaignData["reschedule"], field: "retry" | "interval", value: number | string) => {
    update("reschedule", { ...data.reschedule, [key]: { ...data.reschedule[key], [field]: value } });
  };

  return (
    <div className="space-y-6">
      <Section icon={BookOpen} title="Customer List Selection">
        <Field label="Customer Lists">
          <select value={data.customerList} onChange={(e) => update("customerList", e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
            {CUSTOMER_LISTS.map((c) => (<option key={c}>{c}</option>))}
          </select>
        </Field>
      </Section>

      <Section icon={RefreshCw} title="Reschedule Rules">
        <p className="mb-4 text-sm text-muted-foreground">Configure how to handle different call outcomes and reschedule scenarios</p>
        <div className="grid gap-5 md:grid-cols-3">
          {(["noAnswer", "rejected", "busy"] as const).map((k) => {
            const labels = { noAnswer: "No Answer", rejected: "Rejected", busy: "Busy Signal" } as const;
            return (
              <div key={k}>
                <div className="mb-2 text-sm font-semibold">{labels[k]}</div>
                <label className="mb-2 block text-xs text-muted-foreground">Retry Count:</label>
                <Input type="number" min={0} value={data.reschedule[k].retry} onChange={(e) => setRule(k, "retry", Number(e.target.value))} />
                <label className="mb-1 mt-3 block text-xs text-muted-foreground">Interval (min):</label>
                <select value={data.reschedule[k].interval} onChange={(e) => setRule(k, "interval", e.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">
                  {INTERVALS.map((i) => (<option key={i} value={i}>{i ? `${i} min` : "Select"}</option>))}
                </select>
              </div>
            );
          })}
        </div>
      </Section>

      <Section icon={Moon} title="Google Sheets Integration">
        <p className="mb-4 text-sm text-muted-foreground">Sync call data with Google Sheets</p>
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div>
            <div className="font-semibold">Enable Google Sync</div>
            <div className="text-xs text-muted-foreground">Automatically sync call data with a Google Sheet</div>
          </div>
          <Switch checked={data.googleSync} onCheckedChange={(v) => update("googleSync", v)} />
        </div>
      </Section>
    </div>
  );
}

function Step4({ data, update }: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void }) {
  const provider = useMemo(() => VOIP_PROVIDERS.find((p) => p.id === data.voipProvider)?.name ?? "—", [data.voipProvider]);
  const strategy = useMemo(() => STRATEGIES.find((s) => s.id === data.strategy)?.name ?? "—", [data.strategy]);

  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Summary">
        <div className="grid gap-3 sm:grid-cols-2">
          <ReviewItem label="Campaign Name" value={data.name || "—"} />
          <ReviewItem label="VoIP Provider" value={provider} />
          <ReviewItem label="AI Agent" value={data.agents[0] ?? "—"} />
          <ReviewItem label="Answer Timeout" value={String(data.answerTimeout)} />
          <ReviewItem label="Contact Attempts" value={String(data.maxAttempts)} />
          <ReviewItem label="Active Agents" value={String(data.maxAgents)} />
          <ReviewItem label="Strategy" value={strategy} />
          <ReviewItem label="Customer List" value={data.customerList} />
        </div>
      </Section>

      <Section icon={Rocket} title="Launch Settings">
        <p className="mb-4 text-sm text-muted-foreground">Configure when and how to launch your campaign</p>
        <div className="flex items-center justify-between rounded-lg border border-border p-4">
          <div className="font-semibold">Active</div>
          <Switch checked={data.active} onCheckedChange={(v) => update("active", v)} />
        </div>
      </Section>
    </div>
  );
}

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" />
        </div>
        <h4 className="text-base font-bold">{title}</h4>
      </div>
      {children}
    </div>
  );
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-0">
      <label className="mb-1.5 block text-sm font-semibold">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PillNum({ n, active, onClick }: { n: number; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`flex h-9 w-9 items-center justify-center rounded-full border text-sm font-medium transition ${active ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:border-primary/50"}`}>
      {n}
    </button>
  );
}

function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}

function MultiSelect({ options, value, onChange, placeholder, max }: { options: string[]; value: string[]; onChange: (v: string[]) => void; placeholder: string; max: number }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const toggle = (opt: string) => {
    if (value.includes(opt)) onChange(value.filter((v) => v !== opt));
    else if (value.length < max) onChange([...value, opt]);
    else toast.error(`You can select up to ${max} options`);
  };

  const filtered = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-left text-sm">
        <div className="flex flex-1 flex-wrap gap-1">
          {value.length === 0 ? (
            <span className="text-muted-foreground">{placeholder}</span>
          ) : (
            value.map((v) => (
              <span key={v} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {v}
                <X className="h-3 w-3 cursor-pointer" onClick={(e) => { e.stopPropagation(); toggle(v); }} />
              </span>
            ))
          )}
        </div>
        <ChevronRight className={`h-4 w-4 text-muted-foreground transition ${open ? "rotate-90" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 max-h-72 w-full overflow-hidden rounded-md border border-border bg-popover shadow-lg">
          <div className="border-b border-border p-2">
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Type in to search..." className="h-8 w-full rounded border border-input bg-background px-2 text-sm" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {filtered.map((o) => {
              const selected = value.includes(o);
              return (
                <button key={o} type="button" onClick={() => toggle(o)} className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted ${selected ? "bg-muted/60 font-medium" : ""}`}>
                  {o}
                  {selected && <span className="text-xs text-primary">✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
