import { useEffect, useMemo, useState } from "react";
import {
  X, Rocket, Mic, Phone, Clipboard, Clock, Target,
  SlidersHorizontal, PhoneCall, Shuffle, BookOpen, RefreshCw,
  ChevronLeft, ChevronRight, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: CampaignData) => void;
};

type CampaignData = {
  name: string;
  description: string;
  agentId: string;
  listId: string;
  phoneNumberId: string;
  answerTimeout: number;
  maxAttempts: number;
  strategy: string;
  reschedule: {
    noAnswer: { retry: number; interval: string };
    rejected: { retry: number; interval: string };
    busy:     { retry: number; interval: string };
  };
};

type Agent       = { id: string; name: string };
type ListRow     = { id: string; name: string; contact_count?: number };
type PhoneNumber = { id: string; number: string };

const STRATEGIES = [
  { id: "priority", name: "Priority Based",     desc: "Call high-priority contacts first with more attempts", icon: SlidersHorizontal },
  { id: "max",      name: "Maximum Attempts",   desc: "Prioritize contact success over volume",               icon: PhoneCall },
  { id: "min",      name: "Minimum Attempts",   desc: "Reach maximum contacts with fewer attempts",           icon: Target },
  { id: "random",   name: "Random Strategy",    desc: "Distribute calls randomly across contacts",            icon: Shuffle },
];

const STEPS = [
  { title: "Campaign Basics",            subtitle: "Name, agent, phone number" },
  { title: "Call Settings",              subtitle: "Timeout, attempts, strategy" },
  { title: "Contact List & Reschedule",  subtitle: "Pick the list and configure retry rules" },
  { title: "Review & Launch",            subtitle: "Confirm and launch" },
];

const ATTEMPT_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const INTERVALS = ["", "5", "10", "15", "30", "60", "120"];

const emptyData = (): CampaignData => ({
  name: "", description: "", agentId: "", listId: "", phoneNumberId: "",
  answerTimeout: 30, maxAttempts: 1, strategy: "random",
  reschedule: {
    noAnswer: { retry: 0, interval: "" },
    rejected: { retry: 0, interval: "" },
    busy:     { retry: 0, interval: "" },
  },
});

export function CreateCampaignDialog({ open, onOpenChange, onCreate }: Props) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<CampaignData>(emptyData());

  const [agents, setAgents] = useState<Agent[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([api.getAgents(), api.getLists(), api.getPhoneNumbers()])
      .then(([a, l, p]) => {
        setAgents(Array.isArray(a.data) ? a.data : []);
        setLists(Array.isArray(l.data) ? l.data : []);
        setPhoneNumbers(Array.isArray(p.data) ? p.data : []);
      })
      .finally(() => setLoading(false));
  }, [open]);

  const update = <K extends keyof CampaignData>(key: K, value: CampaignData[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const reset = () => { setStep(0); setData(emptyData()); };

  const close = (next: boolean) => { if (!next) reset(); onOpenChange(next); };

  const progress = ((step + 1) / STEPS.length) * 100;

  const next = () => {
    if (step === 0) {
      if (!data.name.trim()) return toast.error("Campaign name is required");
      if (!data.agentId)     return toast.error("Select an agent");
    }
    if (step === 2 && !data.listId) return toast.error("Select a contact list");
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const back = () => setStep((s) => Math.max(s - 1, 0));

  const launch = () => {
    onCreate?.(data);
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
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading your agents, lists, and numbers…
            </div>
          )}
          {!loading && step === 0 && <Step1 data={data} update={update} agents={agents} phoneNumbers={phoneNumbers} />}
          {!loading && step === 1 && <Step2 data={data} update={update} />}
          {!loading && step === 2 && <Step3 data={data} update={update} lists={lists} />}
          {!loading && step === 3 && <Step4 data={data} agents={agents} lists={lists} phoneNumbers={phoneNumbers} />}
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

/* ───────────────────────────── Steps ───────────────────────────── */

function Step1({
  data, update, agents, phoneNumbers,
}: {
  data: CampaignData;
  update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void;
  agents: Agent[];
  phoneNumbers: PhoneNumber[];
}) {
  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Information">
        <Field label="Campaign Name" required>
          <Input value={data.name} onChange={(e) => update("name", e.target.value)} placeholder="e.g. Q3 Cold Outreach" />
        </Field>
        <Field label="Description" hint="Optional internal note about this campaign">
          <Textarea value={data.description} onChange={(e) => update("description", e.target.value)} placeholder="What's this campaign for?" rows={3} />
        </Field>
      </Section>

      <Section icon={Clipboard} title="AI Agent">
        {agents.length === 0 ? (
          <EmptyHint
            label="No AI agents yet"
            hint="Create an agent in AI Agents → Create AI Agent before launching a campaign."
            href="/dashboard/ai-agents/create"
          />
        ) : (
          <Field label="Agent" required>
            <select
              value={data.agentId}
              onChange={(e) => update("agentId", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Select an agent…</option>
              {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
            </select>
          </Field>
        )}
      </Section>

      <Section icon={Phone} title="Phone Number">
        {phoneNumbers.length === 0 ? (
          <EmptyHint
            label="No phone numbers provisioned"
            hint="You can still launch VAPI will use its default outbound caller ID. Add a number in AI Telephony → Phone Numbers to use your own."
            href="/dashboard/telephony/phone-numbers"
          />
        ) : (
          <Field label="From number (optional)">
            <select
              value={data.phoneNumberId}
              onChange={(e) => update("phoneNumberId", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">VAPI default</option>
              {phoneNumbers.map((p) => (<option key={p.id} value={p.id}>{p.number}</option>))}
            </select>
          </Field>
        )}
      </Section>
    </div>
  );
}

function Step2({
  data, update,
}: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void }) {
  return (
    <div className="space-y-6">
      <Section icon={Clock} title="Call Timing">
        <p className="mb-4 text-sm text-muted-foreground">How long to wait for an answer and how many times to retry.</p>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="mb-2 text-sm font-semibold">Answer Timeout: {data.answerTimeout} seconds</div>
            <input type="range" min={10} max={120} value={data.answerTimeout} onChange={(e) => update("answerTimeout", Number(e.target.value))} className="w-full accent-primary" />
            <div className="mt-1 flex justify-between text-xs text-muted-foreground"><span>10s</span><span>120s</span></div>
          </div>
          <div>
            <div className="mb-2 text-sm font-semibold">Max Contact Attempts: {data.maxAttempts}</div>
            <div className="flex flex-wrap gap-2">
              {ATTEMPT_NUMS.map((n) => (
                <PillNum key={n} n={n} active={data.maxAttempts === n} onClick={() => update("maxAttempts", n)} />
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section icon={Target} title="Call Strategy">
        <p className="mb-4 text-sm text-muted-foreground">How to prioritize and distribute calls.</p>
        <div className="space-y-2">
          {STRATEGIES.map((s) => {
            const selected = data.strategy === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => update("strategy", s.id)}
                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"}`}
              >
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

function Step3({
  data, update, lists,
}: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void; lists: ListRow[] }) {
  const setRule = (key: keyof CampaignData["reschedule"], field: "retry" | "interval", value: number | string) =>
    update("reschedule", { ...data.reschedule, [key]: { ...data.reschedule[key], [field]: value } });

  return (
    <div className="space-y-6">
      <Section icon={BookOpen} title="Contact List">
        {lists.length === 0 ? (
          <EmptyHint
            label="No contact lists yet"
            hint="Create one in Database → Lists and add contacts before launching."
            href="/dashboard/database/lists"
          />
        ) : (
          <Field label="Contact List" required>
            <select
              value={data.listId}
              onChange={(e) => update("listId", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Select a list…</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}{l.contact_count != null ? ` (${l.contact_count} contacts)` : ""}
                </option>
              ))}
            </select>
          </Field>
        )}
      </Section>

      <Section icon={RefreshCw} title="Reschedule Rules">
        <p className="mb-4 text-sm text-muted-foreground">How to handle failed call outcomes.</p>
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
    </div>
  );
}

function Step4({
  data, agents, lists, phoneNumbers,
}: {
  data: CampaignData;
  agents: Agent[];
  lists: ListRow[];
  phoneNumbers: PhoneNumber[];
}) {
  const agentName    = useMemo(() => agents.find((a) => a.id === data.agentId)?.name ?? " ", [agents, data.agentId]);
  const listName     = useMemo(() => lists.find((l) => l.id === data.listId)?.name ?? " ", [lists, data.listId]);
  const numberLabel  = useMemo(() => phoneNumbers.find((p) => p.id === data.phoneNumberId)?.number ?? "VAPI default", [phoneNumbers, data.phoneNumberId]);
  const strategyName = useMemo(() => STRATEGIES.find((s) => s.id === data.strategy)?.name ?? " ", [data.strategy]);

  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Summary">
        <div className="grid gap-3 sm:grid-cols-2">
          <ReviewItem label="Campaign Name"    value={data.name || " "} />
          <ReviewItem label="AI Agent"         value={agentName} />
          <ReviewItem label="Contact List"     value={listName} />
          <ReviewItem label="From Number"      value={numberLabel} />
          <ReviewItem label="Answer Timeout"   value={`${data.answerTimeout}s`} />
          <ReviewItem label="Max Attempts"     value={String(data.maxAttempts)} />
          <ReviewItem label="Strategy"         value={strategyName} />
        </div>
      </Section>
    </div>
  );
}

/* ───────────────────────────── Helpers ───────────────────────────── */

function Section({ icon: Icon, title, children }: { icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="h-4 w-4" /></div>
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

function EmptyHint({ label, hint, href }: { label: string; hint: string; href: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-sm">
      <div className="font-semibold">{label}</div>
      <p className="mt-1 text-muted-foreground">{hint}</p>
      <a href={href} className="mt-2 inline-block text-xs font-semibold text-primary hover:underline">
        Open →
      </a>
    </div>
  );
}
