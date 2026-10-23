/**
 * Receptionist wizard dialog, opened from the AI Receptionist page: CreateReceptionistDialog to make one and
 * EditReceptionistDialog to change one. Same look as the Outbound campaign wizard: large dialog, header with
 * step count, progress bar, section cards and a Previous / Next bar. Two steps: (1) name, AI agent, phone
 * number; (2) the hours the receptionist answers. Editing starts from the receptionist's current values, adds
 * a Status field, shows its number (it cannot be changed here) and offers "Save Changes" on both steps.
 * It does no API calls: it hands the form to onCreate / onSave (the page creates or updates the receptionist
 * and saves the hours on its number) and starts over each time it is opened.
 */
import { useEffect, useState } from "react";
import {
  X, PhoneIncoming, Bot, Phone, Clock, Mic, Power, ChevronLeft, ChevronRight, Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CallingHoursFields } from "@/components/hours/CallingHoursFields";
import { defaultHours, validateHours, type CallingHours } from "@/components/hours/callingHours";

type Agent = { id: string; name: string };
type AvailableNumber = { id: string; number: string };

/** What the wizard hands to onCreate; phone_number_id "" means "buy a new number". */
export type NewReceptionist = { name: string; agent_id: string; phone_number_id: string; hours: CallingHours };

/** What the edit wizard starts from and hands to onSave. */
export type ReceptionistEdit = { name: string; agent_id: string; status: string; hours: CallingHours };

type EditProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  initial: ReceptionistEdit;
  /** The receptionist's number as text, or null when it has none yet (so no answering hours can be set). */
  phoneLabel: string | null;
  hoursUnavailableReason?: string | null;
  /** Saves the form. Return false (or reject) to keep the dialog open, e.g. when the server refused it. */
  onSave: (data: ReceptionistEdit) => Promise<boolean | void> | boolean | void;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Agents that can answer calls (already filtered to those set up in the voice service). */
  agents: Agent[];
  /** Existing numbers that are not answering any calls yet (reusable instead of buying one). */
  availableNumbers: AvailableNumber[];
  /** True while the page is creating the receptionist; locks the wizard. */
  creating: boolean;
  /** Reason answering hours cannot be switched on, or null/undefined when they can. */
  hoursUnavailableReason?: string | null;
  onCreate: (data: NewReceptionist) => unknown;
};

/** Wizard step metadata; index matches the step state (0 basics, 1 hours). */
const STEPS = [
  { title: "Receptionist Basics", subtitle: "Name, agent, phone number" },
  { title: "Answering Hours",     subtitle: "Days and times the receptionist answers" },
];

const emptyForm = () => ({ name: "", agent_id: "", phone_number_id: "" });

/** Two-step wizard for creating an AI receptionist (see the file header). */
export function CreateReceptionistDialog({
  open, onOpenChange, agents, availableNumbers, creating, hoursUnavailableReason, onCreate,
}: Props) {
  return (
    <ReceptionistWizard
      mode="create" open={open} onOpenChange={onOpenChange} agents={agents} availableNumbers={availableNumbers}
      busy={creating} hoursUnavailableReason={hoursUnavailableReason}
      onSubmit={(d) => { onCreate({ name: d.name, agent_id: d.agent_id, phone_number_id: d.phone_number_id, hours: d.hours }); }}
    />
  );
}

/** The same wizard for changing a receptionist: prefilled from `initial`, saved through onSave. */
export function EditReceptionistDialog({ open, onOpenChange, agents, initial, phoneLabel, hoursUnavailableReason, onSave }: EditProps) {
  return (
    <ReceptionistWizard
      mode="edit" open={open} onOpenChange={onOpenChange} agents={agents} availableNumbers={[]} busy={false}
      initial={initial} phoneLabel={phoneLabel} hoursUnavailableReason={hoursUnavailableReason}
      onSubmit={(d) => onSave({ name: d.name, agent_id: d.agent_id, status: d.status, hours: d.hours })}
    />
  );
}

type WizardForm = { name: string; agent_id: string; phone_number_id: string; status: string; hours: CallingHours };

type WizardProps = {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  availableNumbers: AvailableNumber[];
  /** True while the page is creating the receptionist (create mode); locks the wizard. */
  busy: boolean;
  initial?: ReceptionistEdit;
  phoneLabel?: string | null;
  hoursUnavailableReason?: string | null;
  onSubmit: (data: WizardForm) => Promise<boolean | void> | boolean | void;
};

/** The two-step wizard behind both dialogs (see the file header). */
function ReceptionistWizard({
  mode, open, onOpenChange, agents, availableNumbers, busy, initial, phoneLabel, hoursUnavailableReason, onSubmit,
}: WizardProps) {
  const editing = mode === "edit";
  const [step, setStep] = useState<0 | 1>(0);
  const [form, setForm] = useState({ ...emptyForm(), status: "Active" });
  const [hours, setHours] = useState<CallingHours>(defaultHours());
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;

  // Every opening starts from the first step: editing from the receptionist's values, creating from an empty
  // form with the hours off.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    if (editing && initial) {
      setForm({ name: initial.name, agent_id: initial.agent_id, phone_number_id: "", status: initial.status || "Active" });
      setHours(initial.hours);
    } else {
      setForm({ ...emptyForm(), status: "Active" });
      setHours(defaultHours());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const progress = ((step + 1) / STEPS.length) * 100;
  const close = (next: boolean) => { if (!locked) onOpenChange(next); };

  /** Step 1 -> 2: the name and agent are needed before the hours are asked about. */
  const next = () => {
    if (!form.name.trim()) return toast.error("Name is required");
    if (!form.agent_id) return toast.error("Select an AI agent");
    setStep(1);
  };

  /** Checks every field (jumping back to step 1 for a name/agent problem) and hands the form to the page. */
  const submit = async () => {
    if (!form.name.trim()) { setStep(0); return toast.error("Name is required"); }
    if (!form.agent_id) { setStep(0); return toast.error("Select an AI agent"); }
    // Hours only exist for a receptionist that has (or is getting) a number.
    const hoursApply = !editing || !!phoneLabel;
    const problem = hoursApply && hours.enabled ? validateHours(hours) : null;
    if (problem) { setStep(1); return toast.error(problem); }
    if (!editing) { await onSubmit({ ...form, hours }); return; }
    setSaving(true);
    let keepOpen = false;
    try {
      keepOpen = (await onSubmit({ ...form, hours })) === false;
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
          <DialogTitle>{editing ? "Edit AI Receptionist" : "Create AI Receptionist"}</DialogTitle>
          <DialogDescription>
            {editing ? "Change an AI receptionist in 2 steps." : "Set up an AI receptionist that answers a phone number, in 2 steps."}
          </DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow">
              <PhoneIncoming className="h-5 w-5" />
            </div>
            <div className="text-xl font-bold tracking-tight">
              {editing ? "Edit" : "Create"} <span className="text-primary">AI Receptionist</span>
              <span className="ml-1 text-sm font-normal text-muted-foreground">Step {step + 1} of {STEPS.length}</span>
            </div>
          </div>
          <button onClick={() => close(false)} disabled={locked} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
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
          {step === 0 && (
            <div className="space-y-6">
              <Section icon={Mic} title="Receptionist Information">
                <Field label="Name" required hint="A name that tells you what this line is for">
                  <Input
                    placeholder="e.g. Front Desk, Sales Line"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </Field>
              </Section>

              <Section icon={Bot} title="AI Agent">
                <Field label="Agent" required hint="Incoming calls to the number go straight to this agent">
                  <Select value={form.agent_id} onValueChange={(v) => setForm((f) => ({ ...f, agent_id: v }))}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an agent…" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((a) => (<SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </Field>
              </Section>

              {editing && (
                <Section icon={Power} title="Status">
                  <Field label="Status" hint="An Inactive receptionist is switched off.">
                    <Select value={form.status} onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}>
                      <SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="Active">Active</SelectItem>
                        <SelectItem value="Inactive">Inactive</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </Section>
              )}

              {editing ? (
                <Section icon={Phone} title="Phone Number">
                  <p className="text-sm font-semibold">{phoneLabel ?? "No phone number yet"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {phoneLabel ? "The number this receptionist answers. It cannot be changed here." : "Answering hours can be set once this receptionist has a phone number."}
                  </p>
                </Section>
              ) : (
              <Section icon={Phone} title="Phone Number">
                <Field
                  label="Inbound Number"
                  hint={form.phone_number_id
                    ? "This existing number will be reassigned to the agent above. No new purchase."
                    : "A new number is deducted from your wallet, or paid by card if your balance is low."}
                >
                  <Select
                    value={form.phone_number_id || "__new__"}
                    onValueChange={(v) => setForm((f) => ({ ...f, phone_number_id: v === "__new__" ? "" : v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__new__">Buy a new number ($3/month)</SelectItem>
                      {availableNumbers.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.number} (existing, unused)</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </Section>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <Section icon={Clock} title="Answering Hours">
                {editing && !phoneLabel ? (
                  <p className="text-sm text-muted-foreground">Answering hours can be set once this receptionist has a phone number.</p>
                ) : (
                <CallingHoursFields
                  idPrefix={editing ? "receptionist-hours" : "create-receptionist-hours"}
                  value={hours}
                  onChange={setHours}
                  disabled={locked}
                  switchLabel="Only answer during set hours"
                  description="Off: the receptionist answers every call, at any time. On: it answers only on these days, between these times. Callers outside them hear that you are closed and the call ends."
                  startLabel="Answers from"
                  endLabel="Answers until"
                  unavailableReason={hoursUnavailableReason}
                />
                )}
              </Section>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" onClick={() => setStep(0)} disabled={step === 0 || locked} className="w-full sm:w-auto">
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            {/* Editing can save from the first step too; the rest of the form is checked first. */}
            {editing && step === 0 && (
              <Button variant="outline" onClick={submit} disabled={locked} className="w-full sm:w-auto">
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Changes
              </Button>
            )}
            {step === 0 ? (
              <Button onClick={next} disabled={locked} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : editing ? (
              <Button onClick={submit} disabled={locked} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save Changes
              </Button>
            ) : (
              <Button onClick={submit} disabled={locked} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
                {busy
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Provisioning Number…</>
                  : <><PhoneIncoming className="mr-1.5 h-4 w-4" />Create Receptionist</>}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Titled card wrapper for a group of fields (same as the campaign wizard's). */
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
