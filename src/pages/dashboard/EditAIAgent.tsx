/**
 * "Edit AI Agent" modal (default export EditAgentModal), opened for one agent from the AI Agents
 * list (AIAgents.tsx). Loads the agent (GET /agents/{id}) and its call events
 * (GET /agents/{id}/events) into the same step components the create wizard uses, then saves with
 * api.updateAgent (PATCH /agents/{id}) plus api.uploadAgentKnowledge for any newly added files.
 */
import { useEffect, useState } from "react";
import { Check, Loader2, ArrowLeft, ArrowRight, Settings } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { cn, isE164 } from "@/lib/utils";
import { api } from "@/services/api";
import {
  STEPS,
  type StepKey,
  type FormState,
  KNOWLEDGE_TEXT_LIMIT,
  StepSetup,
  StepKnowledge,
  StepPrompt,
  StepTesting,
} from "./CreateAIAgent";
import { StepCallEvents } from "@/components/agents/StepCallEvents";
import { toCallEventsPayload } from "@/components/agents/callEventTypes";

/** The columns of an `ai_agents` row (as returned by GET /agents/{id}) that this modal reads. */
type Agent = {
  id: string;
  name: string;
  status: string;
  voice: string | null;
  language: string | null;
  category: string | null;
  system_prompt: string | null;
  first_message: string | null;
  main_goal: string | null;
  website: string | null;
  transfer_number: string | null;
  selected_tool_keys?: string[] | null;
};

/** Maps a stored language string onto one of the three Select options: English, Urdu or Multilingual. */
// Same normalization the old Settings dialog used — agents created before the language
// list was simplified can have values like "Urdu (PK)" that don't match any Select
// option, which would otherwise render the field blank.
const normalizeLanguage = (lang: string | null): string => {
  if (!lang) return "English";
  if (lang === "Multilingual") return "Multilingual";
  if (/urdu/i.test(lang)) return "Urdu";
  return "English";
};

/** Blank form shown until an agent has loaded; the load effect replaces it with the agent's values. */
const EMPTY_FORM: FormState = {
  agentName: "", website: "", mainGoal: "", transferEnabled: false, transferNumber: "",
  industry: "", language: "English", voice: "Elliot",
  knowledgeText: "", knowledgeFiles: [],
  systemPrompt: "", greeting: "",
  callEvents: [],
  toolKeys: [],
  testMessage: "",
};

/** "No step reviewed yet"; also the reset value when a different agent is opened. */
const EMPTY_COMPLETED: Record<StepKey, boolean> = {
  setup: false, knowledge: false, prompt: false, events: false, testing: false,
};

/**
 * Edit-agent wizard shown in a dialog. Props: `agentId` is the agent to edit (null keeps the
 * dialog closed), `onClose` closes it, and `onSaved` is called after a successful save so the
 * parent list can reload. Uses the same five steps as CreateAIAgent, prefilled from the saved
 * agent, and lets the user jump between steps freely.
 */
export default function EditAgentModal({
  agentId,
  onClose,
  onSaved,
}: {
  agentId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [completed, setCompleted] = useState<Record<StepKey, boolean>>(EMPTY_COMPLETED);
  const [status, setStatus] = useState("Active");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  // Re-fetch and reset the wizard to step 1 every time a different agent is opened.
  useEffect(() => {
    if (!agentId) return;
    // Flipped by the cleanup function so a slow response for a previous agent cannot overwrite
    // the form after the user opened another agent or closed the modal.
    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setStepIndex(0);
    setCompleted(EMPTY_COMPLETED);
    (async () => {
      const { data, error } = await api.getAgent(agentId);
      if (cancelled) return;
      if (error || !data) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      const a = data as Agent;
      // Call events live in their own table, so they need a second request. A failed request
      // is not reported: the list then falls back to empty, and saving would send that empty list.
      const eventsRes = await api.getAgentEvents(agentId);
      if (cancelled) return;
      setForm({
        agentName: a.name ?? "",
        website: a.website ?? "",
        mainGoal: a.main_goal ?? "",
        industry: a.category ?? "",
        language: normalizeLanguage(a.language),
        voice: a.voice ?? "Elliot",
        transferEnabled: !!a.transfer_number,
        transferNumber: a.transfer_number ?? "",
        // Existing knowledge is not loaded: these start empty and only hold what the user adds now.
        knowledgeText: "",
        knowledgeFiles: [],
        systemPrompt: a.system_prompt ?? "",
        greeting: a.first_message ?? "",
        // The form tracks library event ids only, so events without one are left out.
        callEvents: ((eventsRes.data ?? []) as { library_event_id: string | null }[])
          .map((ev) => ev.library_event_id)
          .filter((id): id is string => !!id),
        toolKeys: a.selected_tool_keys ?? [],
        testMessage: "",
      });
      setStatus(a.status ?? "Active");
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  const currentStep = STEPS[stepIndex];
  const completedCount = Object.values(completed).filter(Boolean).length;

  /** Typed single-field setter for the form; handed to every step component as `update`. */
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * Validates only the fields of the current step, showing the first problem as an error toast.
   * Same rules as the create wizard except that the Knowledge step may stay empty.
   */
  const validate = (): boolean => {
    if (currentStep.key === "setup") {
      if (!form.agentName.trim()) { toast.error("Agent name is required"); return false; }
      if (!form.mainGoal.trim()) { toast.error("Main goal is required"); return false; }
      if (form.transferEnabled && !form.transferNumber.trim()) { toast.error("Enter a transfer number or turn off call transfer"); return false; }
      if (form.transferEnabled && !isE164(form.transferNumber)) { toast.error("Transfer number must be in international format, e.g. +15551234567"); return false; }
      if (!form.industry) { toast.error("Please select an industry"); return false; }
    }
    // Knowledge is optional when editing — the agent's existing knowledge is already
    // folded into its system prompt from when it was created; this step is only for
    // adding more, so (unlike Create) it's fine to leave both fields empty.
    if (currentStep.key === "knowledge" && form.knowledgeText.length > KNOWLEDGE_TEXT_LIMIT) {
      toast.error(`Knowledge text exceeds ${KNOWLEDGE_TEXT_LIMIT.toLocaleString()} characters — upload as a file instead`);
      return false;
    }
    if (currentStep.key === "prompt") {
      if (!form.systemPrompt.trim()) { toast.error("System prompt is required"); return false; }
      if (!form.greeting.trim()) { toast.error("Greeting message is required"); return false; }
    }
    // Testing step is optional — no validation; users can run a test or skip.
    return true;
  };

  /**
   * Saves the edit: PATCH /agents/{id} with the whole form, then uploads each newly added
   * knowledge file to POST /agents/{id}/knowledge. Returns false (after an error toast) only when
   * the update itself fails; failed file uploads are toasted but do not change the result.
   */
  const persistToApi = async () => {
    if (!agentId) return false;
    // Any newly typed knowledge text is appended to the system prompt the same way
    // agent creation composes it. The update endpoint deliberately does not re-compose
    // system_prompt itself (that caused a double-composition bug in the past), so this
    // is done once, explicitly, here.
    const newKnowledge = form.knowledgeText.trim();
    const systemPrompt = newKnowledge
      ? `${form.systemPrompt.trim()}\n\nReference knowledge — use this to answer questions accurately:\n${newKnowledge}`
      : form.systemPrompt;

    // The PATCH endpoint only applies non-null fields, so the `|| null` fallbacks below mean
    // "leave unchanged", not "clear". In particular transfer_number is null when call transfer is
    // switched off, and only an empty string would remove a stored transfer; this code never sends
    // one. call_events is the agent's complete event list, which the backend swaps in as a whole.
    const { error } = await api.updateAgent(agentId, {
      name: form.agentName,
      category: form.industry || "General",
      voice: form.voice,
      language: form.language,
      status,
      system_prompt: systemPrompt || null,
      first_message: form.greeting || null,
      main_goal: form.mainGoal || null,
      website: form.website || null,
      transfer_number: form.transferEnabled ? (form.transferNumber.trim() || null) : null,
      call_events: toCallEventsPayload(form.callEvents),
      selected_tool_keys: form.toolKeys,
    });
    if (error) {
      toast.error(error);
      return false;
    }

    if (form.knowledgeFiles.length > 0) {
      let failed = 0;
      for (const file of form.knowledgeFiles) {
        const res = await api.uploadAgentKnowledge(agentId, file);
        if (res.error) {
          failed += 1;
          toast.error(`Failed to upload ${file.name}: ${res.error}`);
        }
      }
      if (failed === 0) {
        toast.success(`Uploaded ${form.knowledgeFiles.length} knowledge file(s)`);
      }
    }

    return true;
  };

  /**
   * Handler of the main button. Validates the current step, marks it reviewed and moves on; on
   * the last step it saves via persistToApi and, on success, toasts, calls onSaved (so the parent
   * list reloads) and closes the modal. `submitting` disables the button during the save.
   */
  const next = async () => {
    if (!validate()) return;
    setCompleted((c) => ({ ...c, [currentStep.key]: true }));
    if (stepIndex < STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
    } else {
      setSubmitting(true);
      try {
        const ok = await persistToApi();
        if (ok) {
          toast.success("Agent updated");
          onSaved();
          onClose();
        }
      } finally {
        setSubmitting(false);
      }
    }
  };

  /** Goes to the previous step without validating; a no-op on the first step. */
  const back = () => stepIndex > 0 && setStepIndex(stepIndex - 1);

  /** Jumps straight to step `i` from the sidebar, with no validation or completion check. */
  // Unlike Create, every field already holds valid data for an existing agent, so there's
  // nothing that forces a strict step order here — let the user jump to any step directly.
  const goToStep = (i: number) => setStepIndex(i);

  // The dialog is open whenever an agent id is set, and any dismissal (overlay, Escape, close
  // button) calls onClose. The body is one of three states: loading, agent not found, or the wizard.
  return (
    <Dialog open={!!agentId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[94vh] max-h-[94vh] flex-col overflow-y-auto p-0 max-w-[max(64rem,70vw)]">
        {loading ? (
          <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading agent…
          </div>
        ) : notFound ? (
          <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Agent not found.</p>
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 border-b border-border bg-background px-5 py-3 pr-12 sm:px-6 sm:pr-12">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Settings className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h1 className="bg-gradient-to-r from-primary to-emerald-400 bg-clip-text text-lg font-bold text-transparent sm:text-xl">
                  Edit AI Agent
                </h1>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground sm:gap-2 sm:text-sm">
                  <span className="max-w-[8rem] truncate font-medium text-foreground sm:max-w-none">{form.agentName || "Edit Agent"}</span>
                  <span>/</span>
                  <span className="text-foreground font-medium">{currentStep.title}</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 p-4 sm:gap-5 sm:p-5 lg:grid-cols-[240px_1fr]">
              <aside className="space-y-4 self-start rounded-2xl border border-border bg-muted/20 p-4 lg:sticky lg:top-0">
                <div>
                  <h2 className="text-base font-semibold">Edit Progress</h2>
                  <p className="text-xs text-muted-foreground">Reviewed {completedCount}/{STEPS.length}</p>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${(completedCount / STEPS.length) * 100}%` }}
                    />
                  </div>
                </div>

                <ul className="grid grid-cols-5 gap-2 lg:grid-cols-1">
                  {STEPS.map((s, i) => {
                    const isActive = i === stepIndex;
                    const isDone = completed[s.key];
                    return (
                      <li key={s.key}>
                        <button
                          onClick={() => goToStep(i)}
                          className={cn(
                            "flex h-full w-full flex-col items-center gap-1.5 rounded-xl border px-1.5 py-2.5 text-center transition sm:p-3 lg:flex-row lg:items-start lg:gap-3 lg:text-left",
                            isActive
                              ? "border-primary/40 bg-primary/5"
                              : "border-transparent hover:bg-muted",
                          )}
                        >
                          <span
                            className={cn(
                              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
                              isDone
                                ? "border-primary bg-primary text-primary-foreground"
                                : isActive
                                ? "border-primary text-primary"
                                : "border-muted-foreground/30 text-muted-foreground",
                            )}
                          >
                            {isDone ? <Check className="h-3 w-3" /> : <span className="text-[10px]">{i + 1}</span>}
                          </span>
                          <div className="min-w-0 lg:flex-1">
                            <div className={cn("text-xs font-medium leading-tight sm:text-sm", isActive ? "text-foreground" : "text-muted-foreground")}>
                              {s.title}
                            </div>
                            {isActive && (
                              <div className="mt-0.5 hidden text-xs text-muted-foreground lg:block">{s.description}</div>
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </aside>

              <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
                <div className="mb-5 border-b border-border pb-4">
                  <h2 className="text-xl font-bold">
                    {currentStep.title} <span className="ml-1 text-sm font-normal text-muted-foreground">Step {stepIndex + 1} of {STEPS.length}</span>
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {currentStep.key === "knowledge"
                      ? "Anything you add here is appended to this agent's existing knowledge — you don't need to re-enter what's already there."
                      : currentStep.description}
                  </p>
                </div>

                {currentStep.key === "setup" && (
                  <StepSetup form={form} update={update} statusValue={status} onStatusChange={setStatus} compact />
                )}
                {currentStep.key === "knowledge" && <StepKnowledge form={form} update={update} compact />}
                {currentStep.key === "prompt" && <StepPrompt form={form} update={update} compact />}
                {currentStep.key === "events" && (
                  <StepCallEvents selectedIds={form.callEvents} onChange={(v) => update("callEvents", v)} compact />
                )}
                {currentStep.key === "testing" && <StepTesting form={form} update={update} compact />}

                <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
                  <Button variant="outline" onClick={back} disabled={stepIndex === 0}>
                    <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
                  </Button>
                  <Button onClick={next} disabled={submitting} className="bg-primary text-primary-foreground">
                    {stepIndex === STEPS.length - 1
                      ? (submitting ? "Saving…" : "Save Changes")
                      : "Continue"}
                    {stepIndex < STEPS.length - 1 && <ArrowRight className="ml-1.5 h-4 w-4" />}
                  </Button>
                </div>
              </section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
