/**
 * Create-receptionist wizard dialog, opened from the AI Receptionist page. Same look as the
 * Outbound "Create Campaign" wizard: large dialog, header with step count, progress bar, section
 * cards and a Previous / Next bar. Two steps: (1) name, AI agent, phone number; (2) the hours the
 * receptionist answers. It does no API calls: it hands the form to onCreate (the page creates the
 * receptionist and saves the hours on its number) and starts over each time it is opened.
 */
import { useEffect, useState } from "react";
import {
  X, PhoneIncoming, Bot, Phone, Clock, Mic, ChevronLeft, ChevronRight, Loader2,
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
  const [step, setStep] = useState<0 | 1>(0);
  const [form, setForm] = useState(emptyForm());
  const [hours, setHours] = useState<CallingHours>(defaultHours());

  // Every opening starts from the first step with an empty form and the hours off.
  useEffect(() => {
    if (open) { setStep(0); setForm(emptyForm()); setHours(defaultHours()); }
  }, [open]);

  const progress = ((step + 1) / STEPS.length) * 100;
  const close = (next: boolean) => { if (!creating) onOpenChange(next); };

  /** Step 1 -> 2: the name and agent are needed before the hours are asked about. */
  const next = () => {
    if (!form.name.trim()) return toast.error("Name is required");
    if (!form.agent_id) return toast.error("Select an AI agent");
    setStep(1);
  };

  /** Checks the hours (when on) and hands the whole form to the page. */
  const create = () => {
    if (!form.name.trim()) return toast.error("Name is required");
    if (!form.agent_id) return toast.error("Select an AI agent");
    const problem = hours.enabled ? validateHours(hours) : null;
    if (problem) return toast.error(problem);
    onCreate({ ...form, hours });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-4xl gap-0 overflow-hidden p-0 sm:rounded-xl [&>button]:hidden">
        <VisuallyHidden>
          <DialogTitle>Create AI Receptionist</DialogTitle>
          <DialogDescription>Set up an AI receptionist that answers a phone number, in 2 steps.</DialogDescription>
        </VisuallyHidden>

        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow">
              <PhoneIncoming className="h-5 w-5" />
            </div>
            <div className="text-xl font-bold tracking-tight">
              Create <span className="text-primary">AI Receptionist</span>
              <span className="ml-1 text-sm font-normal text-muted-foreground">Step {step + 1} of {STEPS.length}</span>
            </div>
          </div>
          <button onClick={() => close(false)} disabled={creating} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
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
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <Section icon={Clock} title="Answering Hours">
                <CallingHoursFields
                  idPrefix="create-receptionist-hours"
                  value={hours}
                  onChange={setHours}
                  disabled={creating}
                  switchLabel="Only answer during set hours"
                  description="Off: the receptionist answers every call, at any time. On: it answers only on these days, between these times. Callers outside them hear that you are closed and the call ends."
                  startLabel="Answers from"
                  endLabel="Answers until"
                  unavailableReason={hoursUnavailableReason}
                />
              </Section>
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="outline" onClick={() => setStep(0)} disabled={step === 0 || creating} className="w-full sm:w-auto">
            <ChevronLeft className="mr-1 h-4 w-4" /> Previous
          </Button>
          {step === 0 ? (
            <Button onClick={next} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={create} disabled={creating} className="w-full bg-primary text-primary-foreground hover:opacity-90 sm:w-auto">
              {creating
                ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Provisioning Number…</>
                : <><PhoneIncoming className="mr-1.5 h-4 w-4" />Create Receptionist</>}
            </Button>
          )}
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
