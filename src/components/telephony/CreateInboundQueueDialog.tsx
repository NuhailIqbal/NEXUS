import { useEffect, useMemo, useState } from "react";
import {
  X,
  PhoneIncoming,
  Phone,
  Bot,
  GitBranch,
  Users,
  ArrowRight,
  Moon,
  Rocket,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
  onCreate?: (data: InboundQueueData) => void;
};

export type InboundQueueData = {
  name: string;
  welcomeMessage: string;
  inboundNumber: string;
  aiAgent: string;
  actions: string[];
  maxAgents: number;
  warmTransfer: boolean;
  googleSync: boolean;
  active: boolean;
};

const PHONE_NUMBERS = ["13153321045", "13152840720", "18005550199", "14155550101"];

const STATIC_AGENT_OPTIONS = [
  "Blair", "Med Alert", "U65 Health Insurance", "HVAC (Outbound)",
  "Solar Installation", "Solar Cancellation", "Bathroom", "Debt Settlement",
];

const ACTION_OPTIONS = [
  "Send SMS", "Send Email", "Update CRM", "Webhook",
  "Schedule Callback", "Voicemail Drop", "Transfer to Agent", "Log to Spreadsheet",
];

const STEPS = [
  { title: "Queue Basics", subtitle: "Name, agent, and phone number" },
  { title: "Queue Configuration", subtitle: "Actions and agents" },
  { title: "Smart Features", subtitle: "AI callbacks, call controls, and warm transfer" },
  { title: "Review & Launch", subtitle: "Review and launch your queue" },
];

export function CreateInboundQueueDialog({ open, onOpenChange, onCreate }: Props) {
  const [agentOptions, setAgentOptions] = useState<string[]>(STATIC_AGENT_OPTIONS);

  useEffect(() => {
    api.getAgents().then(({ data }) => {
      if (data && Array.isArray(data)) {
        const names = data.map((a: any) => a.name).filter(Boolean);
        setAgentOptions([...STATIC_AGENT_OPTIONS, ...names]);
      }
    });
  }, []);

  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [data, setData] = useState<InboundQueueData>({
    name: "",
    welcomeMessage: "",
    inboundNumber: PHONE_NUMBERS[0],
    aiAgent: "Blair",
    actions: [],
    maxAgents: 1,
    warmTransfer: false,
    googleSync: false,
    active: true,
  });

  const progress = useMemo(() => ((step + 1) / STEPS.length) * 100, [step]);

  const reset = () => {
    setStep(0);
    setData({
      name: "", welcomeMessage: "", inboundNumber: PHONE_NUMBERS[0], aiAgent: "Blair",
      actions: [], maxAgents: 1, warmTransfer: false, googleSync: false, active: true,
    });
  };

  const close = (v: boolean) => {
    if (!v) reset();
    onOpenChange(v);
  };

  const next = () => {
    if (step === 0 && !data.name.trim()) return toast.error("Queue name is required");
    if (step === 0 && !data.aiAgent) return toast.error("Please assign an AI agent");
    setStep((s) => Math.min(3, s + 1) as 0 | 1 | 2 | 3);
  };
  const back = () => setStep((s) => Math.max(0, s - 1) as 0 | 1 | 2 | 3);

  const launch = () => {
    onCreate?.(data);
    toast.success(`Inbound queue "${data.name}" launched`);
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto p-0 gap-0">
        <VisuallyHidden>
          <DialogTitle>Create Inbound Queue</DialogTitle>
          <DialogDescription>Configure inbound call routing in 4 steps</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
              <PhoneIncoming className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-xl font-bold">
                Create <span className="text-primary">Inbound Queue</span>
                <span className="ml-2 text-sm font-medium text-muted-foreground">Step {step + 1} of 4</span>
              </h2>
            </div>
          </div>
          <button onClick={() => close(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 pt-5">
          <div className="rounded-xl border border-border bg-muted/30 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold">{STEPS[step].title}</h3>
              <span className="text-sm font-medium text-muted-foreground">{Math.round(progress)}% Complete</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{STEPS[step].subtitle}</p>
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {step === 0 && <StepBasics data={data} setData={setData} agentOptions={agentOptions} />}
          {step === 1 && <StepConfig data={data} setData={setData} />}
          {step === 2 && <StepSmart data={data} setData={setData} />}
          {step === 3 && <StepReview data={data} setData={setData} />}
        </div>

        <div className="flex items-center justify-between border-t border-border px-6 py-4 bg-muted/20">
          <Button variant="outline" onClick={back} disabled={step === 0}>
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
          </Button>
          {step < 3 ? (
            <Button onClick={next} className="bg-primary text-primary-foreground hover:opacity-90">
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={launch} className="bg-primary text-primary-foreground hover:opacity-90">
              <PhoneIncoming className="mr-2 h-4 w-4" /> Launch Queue
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">{icon}</div>
        <h3 className="text-base font-bold">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function StepBasics({ data, setData, agentOptions }: { data: InboundQueueData; setData: React.Dispatch<React.SetStateAction<InboundQueueData>>; agentOptions: string[] }) {
  return (
    <>
      <Section icon={<PhoneIncoming className="h-4 w-4" />} title="Queue Information">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1.5">Name <span className="text-destructive">*</span></label>
            <Input placeholder="Inbound Queue Name" value={data.name} onChange={(e) => setData({ ...data, name: e.target.value })} />
            <p className="mt-1.5 text-xs text-muted-foreground">Choose a descriptive name that identifies the purpose of this queue</p>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1.5">Welcome Message</label>
            <Textarea rows={3} placeholder="Please provide your welcome message" value={data.welcomeMessage} onChange={(e) => setData({ ...data, welcomeMessage: e.target.value })} />
          </div>
        </div>
      </Section>

      <Section icon={<Phone className="h-4 w-4" />} title="Phone Number">
        <label className="block text-sm font-semibold mb-1.5">Inbound Number <span className="text-destructive">*</span></label>
        <div className="relative">
          <select value={data.inboundNumber} onChange={(e) => setData({ ...data, inboundNumber: e.target.value })} className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
            {PHONE_NUMBERS.map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </Section>

      <Section icon={<Bot className="h-4 w-4" />} title="AI Agent Selection">
        <label className="block text-sm font-semibold mb-1.5">Assign AI Agent <span className="text-destructive">*</span></label>
        <div className="relative">
          <select value={data.aiAgent} onChange={(e) => setData({ ...data, aiAgent: e.target.value })} className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
            {agentOptions.map((a) => (<option key={a} value={a}>{a}</option>))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </Section>
    </>
  );
}

function StepConfig({ data, setData }: { data: InboundQueueData; setData: React.Dispatch<React.SetStateAction<InboundQueueData>> }) {
  const toggleAction = (a: string) => {
    setData({ ...data, actions: data.actions.includes(a) ? data.actions.filter((x) => x !== a) : [...data.actions, a] });
  };

  return (
    <>
      <Section icon={<GitBranch className="h-4 w-4" />} title="Actions Selection">
        <label className="block text-sm font-semibold mb-1.5">Actions</label>
        <div className="rounded-md border border-input bg-background p-2 min-h-[44px]">
          {data.actions.length === 0 ? (
            <span className="text-sm text-muted-foreground px-2 py-1 inline-block">Select up to 15 Options...</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {data.actions.map((a) => (
                <span key={a} className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                  {a}
                  <button onClick={() => toggleAction(a)} className="hover:text-primary/70">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {ACTION_OPTIONS.map((a) => {
            const checked = data.actions.includes(a);
            return (
              <button key={a} onClick={() => toggleAction(a)} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition ${checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}>
                <div className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground/30"}`}>
                  {checked && <span className="text-[10px]">✓</span>}
                </div>
                {a}
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={<Users className="h-4 w-4" />} title="Agent Configuration">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-sm font-semibold">Maximum Active Agents: <span className="text-primary">{data.maxAgents}</span></span>
        </div>
        <input type="range" min={1} max={50} value={data.maxAgents} onChange={(e) => setData({ ...data, maxAgents: Number(e.target.value) })} className="w-full accent-primary" />
        <div className="mt-2 flex justify-between text-xs text-muted-foreground">
          <span>1 agent</span>
          <span>50 agents</span>
        </div>
      </Section>
    </>
  );
}

function StepSmart({ data, setData }: { data: InboundQueueData; setData: React.Dispatch<React.SetStateAction<InboundQueueData>> }) {
  return (
    <>
      <Section icon={<ArrowRight className="h-4 w-4" />} title="Warm Transfer to Call Center">
        <p className="text-sm text-muted-foreground mb-3">Seamlessly transfer calls to human agents based on trigger events</p>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-semibold">Enable Warm Transfer</p>
            <p className="text-xs text-muted-foreground">Allow AI to transfer calls to human agents when specific conditions are met</p>
          </div>
          <Switch checked={data.warmTransfer} onCheckedChange={(v) => setData({ ...data, warmTransfer: v })} />
        </div>
      </Section>

      <Section icon={<Moon className="h-4 w-4" />} title="Google Sheets Integration">
        <p className="text-sm text-muted-foreground mb-3">Sync call data with Google Sheets</p>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-semibold">Enable Google Sync</p>
            <p className="text-xs text-muted-foreground">Automatically sync call data with a Google Sheet</p>
          </div>
          <Switch checked={data.googleSync} onCheckedChange={(v) => setData({ ...data, googleSync: v })} />
        </div>
      </Section>
    </>
  );
}

function StepReview({ data, setData }: { data: InboundQueueData; setData: React.Dispatch<React.SetStateAction<InboundQueueData>> }) {
  return (
    <>
      <Section icon={<PhoneIncoming className="h-4 w-4" />} title="Queue Summary">
        <div className="grid grid-cols-2 gap-3">
          <SummaryItem label="Queue Name" value={data.name || " "} />
          <SummaryItem label="Phone Number" value={data.inboundNumber} />
          <SummaryItem label="AI Agent" value={data.aiAgent} />
          <SummaryItem label="Active Agents" value={String(data.maxAgents)} />
        </div>
      </Section>

      <Section icon={<Rocket className="h-4 w-4" />} title="Launch Settings">
        <p className="text-sm text-muted-foreground mb-3">Configure when and how to launch your queue</p>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <p className="text-sm font-semibold">Active</p>
          <Switch checked={data.active} onCheckedChange={(v) => setData({ ...data, active: v })} />
        </div>
      </Section>
    </>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold mt-0.5">{value}</p>
    </div>
  );
}
