import { useEffect, useMemo, useState } from "react";
import {
  X, Rocket, Mic, Phone, Clipboard, BookOpen,
  ChevronLeft, ChevronRight, Loader2, ShieldCheck, ShieldAlert,
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
  agentId: string;
  listId: string;
  phoneNumberId: string;
  dncScreeningEnabled: boolean;
};

type Agent       = { id: string; name: string };
type ListRow     = { id: string; name: string; contact_count?: number };
type PhoneNumber = { id: string; number: string };

const STEPS = [
  { title: "Campaign Basics", subtitle: "Name, agent, phone number" },
  { title: "Contact List",    subtitle: "Pick the list to dial" },
  { title: "Review & Launch", subtitle: "Confirm and launch" },
];

const emptyData = (): CampaignData => ({
  name: "", description: "", agentId: "", listId: "", phoneNumberId: "",
  dncScreeningEnabled: true,
});

export function CreateCampaignDialog({ open, onOpenChange, onCreate }: Props) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<CampaignData>(emptyData());

  const [agents, setAgents] = useState<Agent[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [dncEnabled, setDncEnabled] = useState(false);
  const [dncIntegrationId, setDncIntegrationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([api.getAgents(), api.getLists(), api.getPhoneNumbers(), api.getDncStatus()])
      .then(([a, l, p, d]) => {
        setAgents(Array.isArray(a.data) ? a.data : []);
        setLists(Array.isArray(l.data) ? l.data : []);
        setPhoneNumbers(Array.isArray(p.data) ? p.data : []);
        setDncEnabled(Boolean((d.data as any)?.enabled));
        setDncIntegrationId((d.data as any)?.integration_id ?? null);
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
      if (!data.phoneNumberId) return toast.error("Select a phone number");
    }
    if (step === 1 && !data.listId) return toast.error("Select a contact list");
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
          <DialogDescription>Configure and launch an outbound dialing campaign in 3 steps.</DialogDescription>
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
          {!loading && step === 0 && <Step1 data={data} update={update} agents={agents} phoneNumbers={phoneNumbers} dncEnabled={dncEnabled} dncIntegrationId={dncIntegrationId} />}
          {!loading && step === 1 && <Step3 data={data} update={update} lists={lists} />}
          {!loading && step === 2 && <Step4 data={data} agents={agents} lists={lists} phoneNumbers={phoneNumbers} dncEnabled={dncEnabled} />}
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
  data, update, agents, phoneNumbers, dncEnabled, dncIntegrationId,
}: {
  data: CampaignData;
  update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void;
  agents: Agent[];
  phoneNumbers: PhoneNumber[];
  dncEnabled: boolean;
  dncIntegrationId: string | null;
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
            hint="A phone number is required to launch a campaign. Add one in AI Telephony → Phone Numbers first."
            href="/dashboard/telephony/phone-numbers"
          />
        ) : (
          <Field label="From Number" required>
            <select
              value={data.phoneNumberId}
              onChange={(e) => update("phoneNumberId", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Select a number…</option>
              {phoneNumbers.map((p) => (<option key={p.id} value={p.id}>{p.number}</option>))}
            </select>
          </Field>
        )}
      </Section>

      {/* Account-wide WhitelistData status (Integrations page) gates whether screening is
          possible at all; when it's Active, this campaign can additionally opt out on its
          own — e.g. a list that's already been manually vetted. */}
      <Section icon={ShieldCheck} title="DNC Screening">
        {!dncIntegrationId ? (
          <EmptyHint
            label="WhitelistData not connected"
            hint="Add your WhitelistData credentials in Integrations to screen numbers against the DNC/litigation list before every call."
            href="/dashboard/integrations"
          />
        ) : !dncEnabled ? (
          <EmptyHint
            label="WhitelistData is turned off account-wide"
            hint="Turn it on in Integrations to make screening available to this (and every other) campaign."
            href="/dashboard/integrations"
          />
        ) : (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-foreground">
                {data.dncScreeningEnabled ? "Screening is on for this campaign" : "Screening is off for this campaign"}
              </div>
              <p className="text-xs text-muted-foreground">
                {data.dncScreeningEnabled
                  ? "Numbers found on your DNC/litigation list will be skipped automatically."
                  : "Every number in this campaign's list will be dialed, including suppressed ones."}
              </p>
            </div>
            <Switch checked={data.dncScreeningEnabled} onCheckedChange={(v) => update("dncScreeningEnabled", v)} />
          </div>
        )}
      </Section>
    </div>
  );
}

function Step3({
  data, update, lists,
}: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void; lists: ListRow[] }) {
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
    </div>
  );
}

function Step4({
  data, agents, lists, phoneNumbers, dncEnabled,
}: {
  data: CampaignData;
  agents: Agent[];
  lists: ListRow[];
  phoneNumbers: PhoneNumber[];
  dncEnabled: boolean;
}) {
  const agentName    = useMemo(() => agents.find((a) => a.id === data.agentId)?.name ?? " ", [agents, data.agentId]);
  const listName     = useMemo(() => lists.find((l) => l.id === data.listId)?.name ?? " ", [lists, data.listId]);
  const numberLabel  = useMemo(() => phoneNumbers.find((p) => p.id === data.phoneNumberId)?.number ?? "VAPI default", [phoneNumbers, data.phoneNumberId]);

  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Summary">
        <div className="grid gap-3 sm:grid-cols-2">
          <ReviewItem label="Campaign Name"    value={data.name || " "} />
          <ReviewItem label="AI Agent"         value={agentName} />
          <ReviewItem label="Contact List"     value={listName} />
          <ReviewItem label="From Number"      value={numberLabel} />
        </div>

        {/* Combines the account-wide WhitelistData status with this campaign's own
            opt-in/opt-out choice from Step 1 — both have to be on for screening to run. */}
        {dncEnabled && data.dncScreeningEnabled ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
            <ShieldCheck className="h-4 w-4 shrink-0" />
            DNC screening is active for this campaign. Suppressed numbers will be skipped automatically.
          </div>
        ) : dncEnabled && !data.dncScreeningEnabled ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            DNC screening is turned OFF for this campaign, even though it's on account-wide. Every number in the list will be dialed.
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            DNC screening is off. Every number in the list will be dialed.
            <a href="/dashboard/integrations" target="_blank" rel="noreferrer" className="ml-auto shrink-0 font-semibold text-primary hover:underline">
              Turn on →
            </a>
          </div>
        )}
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
