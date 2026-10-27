/**
 * Campaign wizard dialog, opened from the Outbound campaigns page: CreateCampaignDialog to make a campaign
 * and EditCampaignDialog to change one. Both are the same six steps (basics, contact list, calling hours,
 * call retry, dialing strategy, review); the edit one starts from the campaign's current values, adds a
 * Status field and offers "Save Changes" on every step, so a small change does not need six clicks.
 * Reads api.getAgents, getLists, getPhoneNumbers, getDncStatus and getDialingLimits; the parent performs
 * the actual createCampaign / updateCampaign call.
 */
import { useEffect, useMemo, useState } from "react";
import {
  X, Rocket, Mic, Phone, Clipboard, BookOpen, Check, ChevronsUpDown,
  ChevronLeft, ChevronRight, Loader2, ShieldCheck, ShieldAlert, Clock, Repeat, Gauge, AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { CallingHoursFields } from "@/components/hours/CallingHoursFields";
import {
  defaultHours, describeHours, validateHours, type CallingHours,
} from "@/components/hours/callingHours";
import { DAY_LABELS } from "@/components/integrations/calendarTypes";
import { RetryFields } from "@/components/telephony/RetryFields";
import { defaultRetry, describeFollowup, describeRetry, validateRetry, type RetrySettings } from "@/lib/callRetry";
import { DialingFields } from "@/components/telephony/DialingFields";
import {
  defaultDialing, describeDialing, limitWarning, validateDialing, type DialingLimits, type DialingSettings,
} from "@/lib/dialingStrategy";

/** open/onOpenChange control the dialog; onCreate receives the final form data on launch. */
type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: CampaignData) => void;
};

type EditProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The campaign's current values: the form starts from them each time the dialog opens. */
  initial: CampaignData;
  /** Saves the form. Return false (or reject) to keep the dialog open, e.g. when the server refused it. */
  onSave: (data: CampaignData) => Promise<boolean | void> | boolean | void;
};

/** Form state collected across the wizard steps. */
export type CampaignData = {
  /** "Active" | "Paused" | "Inactive": only offered when editing. */
  status: string;
  name: string;
  description: string;
  agentId: string;
  listId: string;
  phoneNumberId: string;
  dncScreeningEnabled: boolean;
  /** When on, the campaign only places calls on these days between these times. */
  hours: CallingHours;
  /** Call another time when a number does not pick up (see RetryFields). */
  retry: RetrySettings;
  /** How the campaign places its calls: one at a time, several at once or at a steady rate (see DialingFields). */
  dialing: DialingSettings;
};

type Agent       = { id: string; name: string };
type ListRow     = { id: string; name: string; contact_count?: number };
type PhoneNumber = { id: string; number: string };

/** The wizard's steps, in order. Everything below keys off the id, so adding or moving a step is one line here. */
const STEPS = [
  { id: "basics",  title: "Campaign Basics", subtitle: "Name, agent, phone number" },
  { id: "list",    title: "Contact List",    subtitle: "Pick the list to dial" },
  { id: "hours",   title: "Calling Hours",   subtitle: "Days and times the campaign may call" },
  { id: "retry",   title: "Auto Redial",      subtitle: "Call again when a number does not pick up" },
  { id: "dialing", title: "Dialing Strategy", subtitle: "Choose how the campaign places its calls" },
  { id: "review",  title: "Review & Launch", subtitle: "Confirm and launch" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

/** Fresh form state; DNC screening defaults to on for new campaigns. */
const emptyData = (): CampaignData => ({
  status: "Inactive", name: "", description: "", agentId: "", listId: "", phoneNumberId: "",
  dncScreeningEnabled: true,
  hours: defaultHours(),
  retry: defaultRetry(),
  dialing: defaultDialing(),
});

/** Wizard for creating an outbound campaign: hands the data to onCreate and closes. */
export function CreateCampaignDialog({ open, onOpenChange, onCreate }: Props) {
  return <CampaignWizard mode="create" open={open} onOpenChange={onOpenChange} onSubmit={(d) => { onCreate?.(d); }} />;
}

/** The same wizard for changing a campaign: prefilled from `initial`, saved through onSave. */
export function EditCampaignDialog({ open, onOpenChange, initial, onSave }: EditProps) {
  return <CampaignWizard mode="edit" open={open} onOpenChange={onOpenChange} initial={initial} onSubmit={onSave} />;
}

type WizardProps = {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: CampaignData;
  onSubmit: (data: CampaignData) => Promise<boolean | void> | boolean | void;
};

/**
 * The six-step wizard behind both dialogs. Loads agents, lists, phone numbers, DNC status and the account's
 * call limit each time it opens. It does not call the API itself: it hands the data to onSubmit (and closes, unless that returns false).
 */
function CampaignWizard({ mode, open, onOpenChange, initial, onSubmit }: WizardProps) {
  const editing = mode === "edit";
  const [step, setStep] = useState(0);
  const [data, setData] = useState<CampaignData>(initial ?? emptyData());
  const [saving, setSaving] = useState(false);

  const [agents, setAgents] = useState<Agent[]>([]);
  const [lists, setLists] = useState<ListRow[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<PhoneNumber[]>([]);
  const [dncEnabled, setDncEnabled] = useState(false);
  const [dncIntegrationId, setDncIntegrationId] = useState<string | null>(null);
  const [limits, setLimits] = useState<DialingLimits | null>(null);
  const [loading, setLoading] = useState(false);

  // Every opening starts from the first step: editing from the campaign's values, creating from an empty form.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setData(editing && initial ? initial : emptyData());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([api.getAgents(), api.getLists(), api.getPhoneNumbers(), api.getDncStatus(), api.getDialingLimits()])
      .then(([a, l, p, d, dl]) => {
        setAgents(Array.isArray(a.data) ? a.data : []);
        setLists(Array.isArray(l.data) ? l.data : []);
        setPhoneNumbers(Array.isArray(p.data) ? p.data : []);
        setDncEnabled(Boolean((d.data as any)?.enabled));
        setDncIntegrationId((d.data as any)?.integration_id ?? null);
        setLimits(dl.data && typeof dl.data === "object" && "account_limit" in dl.data ? (dl.data as DialingLimits) : null);
      })
      .finally(() => setLoading(false));
  }, [open]);

  /** Type-safe single-field update of the form state. */
  const update = <K extends keyof CampaignData>(key: K, value: CampaignData[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  /** Dialog close handler; discards the form when closing (the next opening starts afresh). */
  const close = (next: boolean) => { if (!saving) onOpenChange(next); };

  const progress = ((step + 1) / STEPS.length) * 100;
  const stepId: StepId = STEPS[step].id;
  // The last step reads "Review & Save" when editing.
  const meta = editing && step === STEPS.length - 1 ? { title: "Review & Save", subtitle: "Confirm your changes" } : STEPS[step];

  /**
   * What is wrong with a step's fields, in words, or null. Creating needs an agent, a number and a list; an
   * existing campaign may not have them yet (it could always be saved without), so editing only needs a name.
   */
  const problemOf = (id: StepId): string | null => {
    if (id === "basics") {
      if (!data.name.trim()) return "Campaign name is required";
      if (!editing && !data.agentId) return "Select an agent";
      if (!editing && !data.phoneNumberId) return "Select a phone number";
    }
    if (id === "list" && !editing && !data.listId) return "Select a contact list";
    if (id === "hours") return data.hours.enabled ? validateHours(data.hours) : null;
    if (id === "retry") return validateRetry(data.retry);
    if (id === "dialing") return validateDialing(data.dialing);
    return null;
  };

  /** Validates the current step's required fields and advances. */
  const next = () => {
    const problem = problemOf(stepId);
    if (problem) return toast.error(problem);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const back = () => setStep((s) => Math.max(s - 1, 0));

  /** Checks every step (jumping to the first one with a problem), then hands the data to the parent. */
  const submit = async () => {
    for (let s = 0; s < STEPS.length; s++) {
      const problem = problemOf(STEPS[s].id);
      if (problem) { setStep(s); return toast.error(problem); }
    }
    setSaving(true);
    let keepOpen = false;
    try {
      keepOpen = (await onSubmit(data)) === false;
    } catch {
      keepOpen = true;
    }
    setSaving(false);
    if (!keepOpen) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0 sm:rounded-xl [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>{editing ? "Edit Outbound Campaign" : "Create Outbound Campaign"}</DialogTitle>
          <DialogDescription>
            {editing ? `Change an outbound dialing campaign in ${STEPS.length} steps.` : `Configure and launch an outbound dialing campaign in ${STEPS.length} steps.`}
          </DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow">
              <Rocket className="h-5 w-5" />
            </div>
            <div className="text-xl font-bold tracking-tight">
              {editing ? "Edit" : "Create"} <span className="text-primary">Outbound Campaign</span>
              <span className="ml-1 text-sm font-normal text-muted-foreground">Step {step + 1} of {STEPS.length}</span>
            </div>
          </div>
          <button onClick={() => close(false)} disabled={saving} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-border bg-primary/5 px-6 py-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-base font-semibold">{meta.title}</h3>
            <span className="text-sm font-medium text-muted-foreground">{Math.round(progress)}% Complete</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{meta.subtitle}</p>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-6 py-6">
          {loading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading your agents, lists, and numbers…
            </div>
          )}
          {!loading && stepId === "basics" && <Step1 data={data} update={update} agents={agents} phoneNumbers={phoneNumbers} dncEnabled={dncEnabled} dncIntegrationId={dncIntegrationId} editing={editing} />}
          {!loading && stepId === "list" && <Step3 data={data} update={update} lists={lists} />}
          {!loading && stepId === "hours" && <StepHours data={data} update={update} />}
          {!loading && stepId === "retry" && <StepRetry data={data} update={update} editing={editing} />}
          {!loading && stepId === "dialing" && <StepDialing data={data} update={update} limits={limits} editing={editing} />}
          {!loading && stepId === "review" && <Step4 data={data} agents={agents} lists={lists} phoneNumbers={phoneNumbers} dncEnabled={dncEnabled} limits={limits} editing={editing} />}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" onClick={back} disabled={step === 0 || saving} className="w-full sm:w-auto">
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {/* Editing can save from any step; the rest of the form is checked first. */}
            {editing && step < STEPS.length - 1 && (
              <Button variant="outline" onClick={submit} disabled={saving} className="w-full sm:w-auto">
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Changes
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button onClick={next} disabled={saving} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={submit} disabled={saving} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
                {saving
                  ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  : editing ? null : <Rocket className="mr-1.5 h-4 w-4" />}
                {editing ? "Save Changes" : "Launch Campaign"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────────── Steps ───────────────────────────── */

/** Step 1: name, description, agent, from-number and per-campaign DNC screening toggle. */
function Step1({
  data, update, agents, phoneNumbers, dncEnabled, dncIntegrationId, editing,
}: {
  data: CampaignData;
  update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void;
  agents: Agent[];
  phoneNumbers: PhoneNumber[];
  dncEnabled: boolean;
  dncIntegrationId: string | null;
  editing?: boolean;
}) {
  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Information">
        <Field label="Campaign Name" required>
          <Input value={data.name} onChange={(e) => update("name", e.target.value)} placeholder="e.g. Q3 Cold Outreach" />
        </Field>
        {editing ? (
          <Field label="Status" hint="Active campaigns place calls (and redials); Paused and Inactive ones do not.">
            <Select value={data.status} onValueChange={(v) => update("status", v)}>
              <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Paused">Paused</SelectItem>
                <SelectItem value="Inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label="Description" hint="Optional internal note about this campaign">
            <Textarea value={data.description} onChange={(e) => update("description", e.target.value)} placeholder="What's this campaign for?" rows={3} />
          </Field>
        )}
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
            <Select value={data.agentId} onValueChange={(v) => update("agentId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select an agent…" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (<SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>))}
              </SelectContent>
            </Select>
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
            <PhoneNumberCombobox phoneNumbers={phoneNumbers} value={data.phoneNumberId} onChange={(v) => update("phoneNumberId", v)} />
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

/** Step 3 of the wizard: the days and times the campaign may place calls (off = any time). */
function StepHours({
  data, update,
}: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void }) {
  return (
    <div className="space-y-6">
      <Section icon={Clock} title="Calling Hours">
        <CallingHoursFields
          advanced
          idPrefix="campaign-hours"
          value={data.hours}
          onChange={(h) => update("hours", h)}
          switchLabel="Only call during set hours"
          description="Off: the campaign can place calls at any time. On: calls are only placed on these days, between these times. Outside them it will not start. A run that is still going when they end, or when a break begins, stops and carries on by itself from the next contact when the hours (or the break) are over (no need to press Start again)."
          startLabel="Calls start"
          endLabel="Calls stop"
        />
      </Section>
    </div>
  );
}

/** Step 4 of the wizard: call retry (call a number again when it does not pick up; off by default). */
function StepRetry({
  data, update, editing,
}: { data: CampaignData; update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void; editing?: boolean }) {
  return (
    <div className="space-y-6">
      <Section icon={Repeat} title="Auto Redial">
        <RetryFields idPrefix="campaign-retry" value={data.retry} onChange={(r) => update("retry", r)} editing={editing} />
      </Section>
    </div>
  );
}

/** Step 5 of the wizard: the dialing strategy (how many calls at once, or at what rate) and the delay between calls. */
function StepDialing({
  data, update, limits, editing,
}: {
  data: CampaignData;
  update: <K extends keyof CampaignData>(k: K, v: CampaignData[K]) => void;
  limits: DialingLimits | null;
  editing?: boolean;
}) {
  return (
    <div className="space-y-6">
      <Section icon={Gauge} title="Dialing Strategy">
        <DialingFields idPrefix="campaign-dialing" value={data.dialing} onChange={(v) => update("dialing", v)} limits={limits} editing={editing} />
      </Section>
    </div>
  );
}

/** Step 2 of the wizard (named Step3): contact list picker. */
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
            <Select value={data.listId} onValueChange={(v) => update("listId", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select a list…" />
              </SelectTrigger>
              <SelectContent>
                {lists.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}{l.contact_count != null ? ` (${l.contact_count} contacts)` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      </Section>
    </div>
  );
}

/** The last step of the wizard (named Step4): read-only review of the chosen options. */
function Step4({
  data, agents, lists, phoneNumbers, dncEnabled, limits, editing,
}: {
  data: CampaignData;
  agents: Agent[];
  lists: ListRow[];
  phoneNumbers: PhoneNumber[];
  dncEnabled: boolean;
  limits: DialingLimits | null;
  editing?: boolean;
}) {
  const capWarning = limitWarning(data.dialing, limits);
  const agentName    = useMemo(() => agents.find((a) => a.id === data.agentId)?.name ?? " ", [agents, data.agentId]);
  const listName     = useMemo(() => lists.find((l) => l.id === data.listId)?.name ?? " ", [lists, data.listId]);
  const numberLabel  = useMemo(() => phoneNumbers.find((p) => p.id === data.phoneNumberId)?.number ?? "Default number", [phoneNumbers, data.phoneNumberId]);

  return (
    <div className="space-y-6">
      <Section icon={Mic} title="Campaign Summary">
        <div className="grid gap-3 sm:grid-cols-2">
          <ReviewItem label="Campaign Name"    value={data.name || " "} />
          {editing && <ReviewItem label="Status" value={data.status} />}
          <ReviewItem label="AI Agent"         value={agentName} />
          <ReviewItem label="Contact List"     value={listName} />
          <ReviewItem label="From Number"      value={numberLabel} />
          <ReviewItem label="Calling Hours"     value={data.hours.enabled ? describeHours(data.hours, DAY_LABELS) : "Any time"} />
          <ReviewItem label="Auto Redial"        value={describeRetry(data.retry)} />
          <ReviewItem label="Second-chance rounds" value={describeFollowup(data.retry)} />
          <ReviewItem label="Dialing Strategy"   value={describeDialing(data.dialing)} />
        </div>

        {capWarning && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            {capWarning}
          </div>
        )}

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

/** Titled card wrapper for a group of fields. */
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

/** Label (with optional required marker) and hint around a form control. */
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

/** Label/value tile in the review step. */
function ReviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold">{value}</div>
    </div>
  );
}

/** Placeholder shown when a prerequisite is missing, with a link to set it up. */
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

/** Searchable phone number picker; reports the selected number's id. */
function PhoneNumberCombobox({
  phoneNumbers, value, onChange,
}: {
  phoneNumbers: PhoneNumber[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = phoneNumbers.find((p) => p.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 text-sm"
        >
          <span className={selected ? "" : "text-muted-foreground"}>
            {selected ? selected.number : "Select a number…"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder="Type a number to search…" />
          <CommandList>
            <CommandEmpty>No matching number.</CommandEmpty>
            <CommandGroup>
              {phoneNumbers.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.number}
                  onSelect={() => { onChange(p.id); setOpen(false); }}
                >
                  <Check className={cn("mr-2 h-4 w-4", value === p.id ? "opacity-100" : "opacity-0")} />
                  {p.number}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
