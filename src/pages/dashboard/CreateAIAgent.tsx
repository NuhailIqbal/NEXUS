/**
 * "Create AI Agent" wizard page, routed at /dashboard/ai-agents/create (reached from the
 * AI Agents list). Collects setup, knowledge, prompt, call events and an optional test, then
 * saves on the last step with api.createAgent (POST /agents).
 * It also exports the step components, form types and knowledge limits that EditAIAgent.tsx
 * reuses for its prefilled edit wizard.
 */
import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  X, Check, Bot, BookOpen, FileText, PlayCircle, Sparkles, Briefcase,
  ArrowLeft, ArrowRight, Info, Loader2, Phone, Zap, Maximize2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, isE164 } from "@/lib/utils";
import { ALL_VOICE_NAMES } from "@/lib/voices";
import { AGENT_LANGUAGES, greetingNote, greetingPlaceholder, voiceAfterLanguageChange, voiceLanguageNote } from "@/lib/languages";
import { api } from "@/services/api";
import { AgentCreatedSuccessModal } from "@/components/dashboard/AgentCreatedSuccessModal";
import { LiveVoiceModal, VoiceAgentInfo } from "@/components/dashboard/LiveVoiceModal";
import { IndustryCombobox } from "@/components/dashboard/IndustryCombobox";
import { StepCallEvents } from "@/components/agents/StepCallEvents";
import { toCallEventsPayload } from "@/components/agents/callEventTypes";

/** Identifier of each wizard step; the order is defined by STEPS. */
export type StepKey = "setup" | "knowledge" | "prompt" | "events" | "testing";

/**
 * The wizard's steps in display order. Shared with EditAIAgent.tsx so the create and edit
 * wizards always show the same sequence of steps.
 */
export const STEPS: { key: StepKey; title: string; description: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "setup", title: "Complete Setup", description: "Basic agent configuration and tools", icon: Bot },
  { key: "knowledge", title: "Knowledge Center", description: "Add what the agent should know", icon: BookOpen },
  { key: "prompt", title: "Prompt Studio", description: "Craft the agent's instructions", icon: FileText },
  { key: "events", title: "Call Events", description: "Moments the agent reports during calls", icon: Zap },
  { key: "testing", title: "Testing", description: "Test before going live", icon: PlayCircle },
];

/**
 * All values the wizard collects, held in one object. The same shape is used by the create
 * page and the edit modal; fields are mapped to API request fields in each page's persistToApi.
 * `knowledgeText` is a write-only input: it is never read back from an existing agent
 * (the edit modal starts it empty).
 */
export type FormState = {
  agentName: string;
  website: string;
  mainGoal: string;
  industry: string;
  language: string;
  voice: string;
  transferEnabled: boolean;
  transferNumber: string;
  knowledgeText: string;
  systemPrompt: string;
  greeting: string;
  callEvents: string[]; // ids of call events chosen from the event library
  toolKeys: string[]; // tool presets the agent may use during calls (SMS, email, calendar...)
  testMessage: string;
};

/**
 * Limit for the Knowledge step: maximum pasted-text length (characters). Enforced in the browser
 * only (StepKnowledge and the validate functions).
 */
export const KNOWLEDGE_TEXT_LIMIT = 8000;

/**
 * Create-agent wizard page. Owns the step index, per-step completion flags and the form state,
 * validates each step on Continue, and on the final step creates the agent through the API and
 * then shows AgentCreatedSuccessModal. Nothing is saved before that last step.
 */
const CreateAIAgent = () => {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);
  // A step is marked completed when the user passes its validation with Continue. This drives
  // the progress bar and decides which steps goToStep lets the user jump to.
  const [completed, setCompleted] = useState<Record<StepKey, boolean>>({
    setup: false, knowledge: false, prompt: false, events: false, testing: false,
  });
  const [form, setForm] = useState<FormState>({
    agentName: "", website: "", mainGoal: "", transferEnabled: false, transferNumber: "", industry: "", language: "English", voice: "Elliot",
    knowledgeText: "",
    systemPrompt: "", greeting: "",
    callEvents: [],
    toolKeys: [],
    testMessage: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const currentStep = STEPS[stepIndex];
  const completedCount = Object.values(completed).filter(Boolean).length;

  /** Leaves the wizard without saving and returns to the agents list. */
  const close = () => navigate("/dashboard/ai-agents");

  /** Typed single-field setter for the form; handed to every step component as `update`. */
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /**
   * Validates only the fields of the current step. Shows the first problem as an error toast
   * and returns false; returns true when the step may be left. The Knowledge step needs pasted
   * text or at least one file, and the Testing and Call Events steps have no rules.
   */
  const validate = (): boolean => {
    if (currentStep.key === "setup") {
      if (!form.agentName.trim()) { toast.error("Agent name is required"); return false; }
      if (!form.mainGoal.trim()) { toast.error("Main goal is required"); return false; }
      if (form.transferEnabled && !form.transferNumber.trim()) { toast.error("Enter a transfer number or turn off call transfer"); return false; }
      // Same E.164 rule the backend applies, so a malformed number is caught here instead of
      // surfacing later as a voice-service error.
      if (form.transferEnabled && !isE164(form.transferNumber)) { toast.error("Transfer number must be in international format, e.g. +15551234567"); return false; }
      if (!form.industry) { toast.error("Please select an industry"); return false; }
    }
    if (currentStep.key === "knowledge") {
      if (!form.knowledgeText.trim()) {
        toast.error("Add some knowledge text before continuing");
        return false;
      }
      if (form.knowledgeText.length > KNOWLEDGE_TEXT_LIMIT) {
        toast.error(`Knowledge text exceeds ${KNOWLEDGE_TEXT_LIMIT.toLocaleString()} characters, please shorten it`);
        return false;
      }
    }
    if (currentStep.key === "prompt") {
      if (!form.systemPrompt.trim()) { toast.error("System prompt is required"); return false; }
      if (!form.greeting.trim()) { toast.error("Greeting message is required"); return false; }
    }
    // Testing step is optional — no validation; users can run a test or skip.
    return true;
  };

  /**
   * Saves the wizard: creates the agent with POST /agents, then uploads each knowledge file to
   * POST /agents/{id}/knowledge. Returns false (after an error toast) only when the agent itself
   * could not be created; individual file-upload failures are toasted but still return true.
   */
  const persistToApi = async () => {
    // The industry label is stored in the agent's `category` field. status is always "Active"
    // because the create flow has no status control. knowledge_text is sent raw: the backend
    // folds it (and the main goal) into the saved system prompt and also records it as a
    // knowledge row, so the prompt is not composed on the client here. transfer_number is
    // null when transfer is switched off, which means no transfer tool is set up.
    const { data, error } = await api.createAgent({
      name: form.agentName,
      category: form.industry || "General",
      voice: form.voice,
      language: form.language,
      status: "Active",
      system_prompt: form.systemPrompt || null,
      first_message: form.greeting || null,
      main_goal: form.mainGoal || null,
      website: form.website || null,
      transfer_number: form.transferEnabled ? (form.transferNumber.trim() || null) : null,
      knowledge_text: form.knowledgeText || null,
      call_events: toCallEventsPayload(form.callEvents),
      selected_tool_keys: form.toolKeys,
    });
    if (error || !data?.id) {
      toast.error(error || "Failed to create agent");
      return false;
    }

    return true;
  };

  /**
   * Handler of the main button. Validates the current step, marks it completed and moves to
   * the next one; on the last step it saves via persistToApi and, on success, opens the
   * success modal. `submitting` disables the button for the duration of the save.
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
        if (ok) setShowSuccess(true);
      } finally {
        setSubmitting(false);
      }
    }
  };

  /** Goes to the previous step without validating; a no-op on the first step. */
  const back = () => stepIndex > 0 && setStepIndex(stepIndex - 1);

  /**
   * Sidebar step navigation. Moving back or to an already completed step is allowed; jumping
   * forward to a step that has not been completed is refused so required fields are not skipped.
   */
  const goToStep = (i: number) => {
    if (i <= stepIndex || completed[STEPS[i].key]) setStepIndex(i);
    else toast.error("Complete the current step first");
  };

  // The negative margins cancel the dashboard layout's page padding so the wizard fills the
  // content area edge to edge; the header is sticky just below the 4rem dashboard top bar.
  return (
    <div className="-mx-4 -my-6 min-h-[calc(100vh-4rem)] bg-muted/30 sm:-mx-6 lg:-mx-8">
      <div className="sticky top-16 z-20 flex items-start justify-between gap-3 border-b border-border bg-background px-4 py-3 sm:items-center sm:px-6 sm:py-4">
        <div className="min-w-0">
          <h1 className="bg-gradient-to-r from-primary to-emerald-400 bg-clip-text text-xl font-bold text-transparent sm:text-2xl">
            Create AI Agent
          </h1>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground sm:gap-2 sm:text-sm">
            <Link to="/dashboard/ai-agents" className="hover:text-primary">AI Agents</Link>
            <span>/</span>
            <span>Create AI Agent</span>
            <span>/</span>
            <span className="text-foreground font-medium">{currentStep.title}</span>
          </div>
        </div>
        <button
          onClick={close}
          className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-muted"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 sm:gap-6 sm:p-6 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Setup Progress</h2>
            <p className="text-xs text-muted-foreground">Completed {completedCount}/{STEPS.length}</p>
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
          <div className="mb-6">
            <h2 className="text-xl font-bold">
              {currentStep.title} <span className="ml-1 text-sm font-normal text-muted-foreground">Step {stepIndex + 1} of {STEPS.length}</span>
            </h2>
            <p className="text-sm text-muted-foreground">{currentStep.description}</p>
          </div>

          <div className="rounded-xl border border-border bg-background p-3 sm:p-6">
            {currentStep.key === "setup" && <StepSetup form={form} update={update} />}
            {currentStep.key === "knowledge" && <StepKnowledge form={form} update={update} />}
            {currentStep.key === "prompt" && <StepPrompt form={form} update={update} />}
            {currentStep.key === "events" && (
              <StepCallEvents selectedIds={form.callEvents} onChange={(v) => update("callEvents", v)} />
            )}
            {currentStep.key === "testing" && <StepTesting form={form} update={update} />}
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-border pt-4">
            <Button variant="outline" onClick={back} disabled={stepIndex === 0}>
              <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
            </Button>
            <Button onClick={next} disabled={submitting} className="bg-primary text-primary-foreground">
              {stepIndex === STEPS.length - 1
                ? (submitting ? "Creating…" : "Create Agent")
                : "Continue"}
              {stepIndex < STEPS.length - 1 && <ArrowRight className="ml-1.5 h-4 w-4" />}
            </Button>
          </div>
        </section>
      </div>

      <AgentCreatedSuccessModal
        open={showSuccess}
        agentName={form.agentName}
        onClose={() => {
          setShowSuccess(false);
          navigate("/dashboard/ai-agents");
        }}
      />
    </div>
  );
};

export default CreateAIAgent;

/* ---------------- Step Components ---------------- */

/**
 * Setup step: name, website (with AI "Analyze" autofill), main goal, call transfer, agent tools,
 * industry, language and voice. Used by the create wizard and, with `compact` and a status
 * selector, by the edit modal. Calls api.analyzeAgentWebsite when "Analyze" is pressed.
 */
export function StepSetup({
  form, update, statusValue, onStatusChange, compact,
}: {
  form: FormState;
  update: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  // Only set when editing an existing agent — a brand new agent is always created Active,
  // so Create never passes these and the field stays hidden.
  statusValue?: string;
  onStatusChange?: (v: string) => void;
  // Hides the centered intro block; the Edit modal already shows the step title itself.
  compact?: boolean;
}) {
  // The full voice catalog from @/lib/voices; every voice is offered whatever the language.
  const voiceOptions = ALL_VOICE_NAMES;
  const [analyzing, setAnalyzing] = useState(false);
  // Set when the voice can't speak the language (see voiceLanguageNote); null most of the time.
  const voiceNote = voiceLanguageNote(form.language, form.voice);

  /**
   * Language dropdown handler. Spanish and German can't use the English-only voices, so picking one
   * of them while such a voice is selected moves the voice to that language's default; any other
   * change leaves the voice alone.
   */
  const changeLanguage = (language: string) => {
    update("language", language);
    const voice = voiceAfterLanguageChange(language, form.voice);
    if (voice !== form.voice) update("voice", voice);
  };

  /**
   * "Analyze" button handler: asks the backend (POST /agents/analyze-website, rate limited per
   * IP) to read the entered website and suggest a main goal and industry. A suggestion replaces
   * whatever is currently in those fields; the industry is only replaced when one is returned.
   */
  const analyzeWebsite = async () => {
    if (!form.website.trim()) return toast.error("Enter a website URL first");
    setAnalyzing(true);
    const { data, error } = await api.analyzeAgentWebsite(form.website.trim());
    setAnalyzing(false);
    if (error) return toast.error(error);
    if (data?.main_goal) update("mainGoal", data.main_goal);
    if (data?.industry) update("industry", data.industry);
    toast.success("Filled in Main Goal" + (data?.industry ? " and Industry" : "") + " from the website");
  };

  return (
    <div className={compact ? "space-y-6" : "space-y-8"}>
      {!compact && (
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="h-7 w-7" />
          </div>
          <h3 className="mt-3 text-lg font-bold">Complete Agent Setup</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure your agent's basic information, purpose, and communication settings
          </p>
        </div>
      )}

      <div>
        <SectionTitle icon={<Bot className="h-4 w-4 text-primary" />}>Basic Information</SectionTitle>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <Field label="Agent Name" required>
            <input
              value={form.agentName}
              onChange={(e) => update("agentName", e.target.value)}
              placeholder="Enter your agent's name…"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
          </Field>
          <Field label="Website (Optional)">
            <div className="flex gap-2">
              <input
                value={form.website}
                onChange={(e) => update("website", e.target.value)}
                placeholder="example.com or https://example.com"
                className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-10 shrink-0 text-primary border-primary/30"
                onClick={analyzeWebsite}
                disabled={analyzing}
              >
                {analyzing ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-1 h-3.5 w-3.5" />}
                Analyze
              </Button>
            </div>
          </Field>
        </div>
        <Field label="Main Goal" required className="mt-4">
          <textarea
            value={form.mainGoal}
            onChange={(e) => update("mainGoal", e.target.value)}
            placeholder="Describe what you want your agent to accomplish…"
            rows={4}
            className="w-full rounded-md border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
          />
        </Field>
        <div className="mt-4">
          <div className="flex items-center justify-between gap-4 rounded-md border border-input bg-background/40 p-3">
            <div>
              <span className="block text-sm font-medium text-foreground">Call transfer</span>
              <p className="text-xs text-muted-foreground">Transfer qualified calls to a human phone number.</p>
            </div>
            <Switch
              checked={form.transferEnabled}
              onCheckedChange={(v) => update("transferEnabled", v)}
            />
          </div>
          {form.transferEnabled && (
            <Field label="Transfer Number" required className="mt-3">
              <input
                value={form.transferNumber}
                onChange={(e) => update("transferNumber", e.target.value)}
                placeholder="+15551234567"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                When a call is qualified, it will be transferred to this number. Use international format, like +15551234567.
              </p>
            </Field>
          )}
        </div>
        {onStatusChange && (
          <Field label="Status" className="mt-4">
            <Select value={statusValue ?? "Active"} onValueChange={onStatusChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Active">Active</SelectItem>
                <SelectItem value="Paused">Paused</SelectItem>
                <SelectItem value="Inactive">Inactive</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>

      <div>
        <SectionTitle icon={<Briefcase className="h-4 w-4 text-primary" />}>Business Context</SectionTitle>
        <Field label="Industry" required className="mt-4">
          <IndustryCombobox value={form.industry} onChange={(label) => update("industry", label)} />
        </Field>
      </div>

      <div>
        <SectionTitle icon={<Sparkles className="h-4 w-4 text-primary" />}>Communication</SectionTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Language">
            <Select value={form.language} onValueChange={changeLanguage}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_LANGUAGES.map((l) => (
                  <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Voice">
            <Select value={form.voice} onValueChange={(v) => update("voice", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {voiceOptions.map((v) => (
                  <SelectItem key={v} value={v}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {voiceNote && <p className="mt-1 text-xs text-warning" role="note">{voiceNote}</p>}
          </Field>
        </div>
      </div>
    </div>
  );
}

/**
 * Knowledge step: a quick-text box capped at KNOWLEDGE_TEXT_LIMIT characters. Nothing is sent
 * from here; the text is kept in the form and submitted by the page's persistToApi.
 * `compact` hides the intro block (edit modal).
 */
export function StepKnowledge({
  form, update, compact,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void; compact?: boolean }) {
  const textLen = form.knowledgeText.length;
  const textOver = textLen > KNOWLEDGE_TEXT_LIMIT;

  return (
    <div className="space-y-6">
      {!compact && (
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <BookOpen className="h-7 w-7" />
          </div>
          <h3 className="mt-3 text-lg font-bold">Knowledge Center</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Give your agent the info it needs to answer accurately
          </p>
        </div>
      )}

      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="flex items-start gap-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-foreground">What to include</p>
            <p className="text-muted-foreground">
              Add the information your agent should rely on when speaking with customers: FAQs, pricing, policies, service details and call scripts. This content becomes part of the agent's instructions and is applied on every call.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="text-sm font-medium">Business Knowledge</span>
          <span className={cn("text-xs", textOver ? "text-destructive font-semibold" : "text-muted-foreground")}>
            {textLen.toLocaleString()} / {KNOWLEDGE_TEXT_LIMIT.toLocaleString()}
          </span>
        </div>
        <textarea
          value={form.knowledgeText}
          onChange={(e) => update("knowledgeText", e.target.value)}
          rows={8}
          placeholder="Paste FAQs, product info, policies, scripts…"
          className={cn(
            "w-full rounded-md border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30",
            textOver ? "border-destructive" : "border-input",
          )}
        />
        {textOver && (
          <p className="text-xs text-destructive">
            This is too long. Shorten it to the key points that matter on a call.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Prompt step: the agent's system prompt and its opening greeting (sent as `first_message`).
 * Both are required by the page validators. `compact` hides the intro and makes the prompt box taller.
 */
export function StepPrompt({
  form, update, compact,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void; compact?: boolean }) {
  const [promptExpanded, setPromptExpanded] = useState(false);
  return (
    <div className="space-y-6">
      {!compact && (
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <FileText className="h-7 w-7" />
          </div>
          <h3 className="mt-3 text-lg font-bold">Prompt Studio</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Define how your agent thinks and speaks
          </p>
        </div>
      )}
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <label htmlFor="system-prompt" className="text-sm font-medium">
            System Prompt <span className="text-destructive">*</span>
          </label>
          <button
            type="button"
            onClick={() => setPromptExpanded(true)}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Expand editor"
            aria-label="Expand editor"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
        <textarea
          id="system-prompt"
          value={form.systemPrompt}
          onChange={(e) => update("systemPrompt", e.target.value)}
          rows={compact ? 14 : 6}
          placeholder="You are a friendly assistant who helps users with…"
          className="w-full rounded-md border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </div>
      <Dialog open={promptExpanded} onOpenChange={setPromptExpanded}>
        <DialogContent className="flex h-[90vh] max-h-[90vh] max-w-5xl flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>System Prompt</DialogTitle>
            <DialogDescription>Edit the full script here. Changes are saved to the form as you type.</DialogDescription>
          </DialogHeader>
          <textarea
            value={form.systemPrompt}
            onChange={(e) => update("systemPrompt", e.target.value)}
            placeholder="You are a friendly assistant who helps users with…"
            className="min-h-0 w-full flex-1 resize-none rounded-md border border-input bg-background p-4 text-sm leading-relaxed outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div className="flex justify-end">
            <Button type="button" onClick={() => setPromptExpanded(false)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
      <Field label="Greeting Message" required>
        <input
          value={form.greeting}
          onChange={(e) => update("greeting", e.target.value)}
          placeholder={greetingPlaceholder(form.language)}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
        {greetingNote(form.language) && (
          <p className="mt-1 text-xs text-muted-foreground">{greetingNote(form.language)}</p>
        )}
      </Field>
    </div>
  );
}

/**
 * Testing step (optional): try the agent from the unsaved form before saving it. Offers a live
 * voice call (a temporary assistant opened in LiveVoiceModal) and a text test that shows one
 * model reply. Neither path saves the agent. `compact` hides the intro block (edit modal).
 */
export function StepTesting({
  form, update, compact,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void; compact?: boolean }) {
  const [reply, setReply] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Non-null while the voice-test modal is open; holds the temporary assistant to talk to.
  const [voiceTestAgent, setVoiceTestAgent] = useState<VoiceAgentInfo | null>(null);
  const [voiceTestStarting, setVoiceTestStarting] = useState(false);

  /**
   * Text test: sends the test message with the current system prompt, greeting and language to
   * POST /agents/test, which makes a single model completion without saving anything. The
   * reply therefore reflects only the prompt, greeting and language rules, not tools, call
   * events or knowledge.
   */
  const runTest = async () => {
    if (!form.testMessage.trim()) {
      toast.error("Type a test message first");
      return;
    }
    setLoading(true);
    setReply(null);
    const { data, error } = await api.testAgent({
      message: form.testMessage,
      system_prompt: form.systemPrompt || null,
      first_message: form.greeting || null,
      language: form.language || null,
    });
    setLoading(false);
    if (error) {
      toast.error(error);
      return;
    }
    setReply(data?.reply ?? "");
  };

  /**
   * Starts a live voice test: POST /agents/test-voice/start creates a temporary voice-service
   * assistant from the unsaved form (name, voice, language, prompt, greeting only; the main
   * goal, knowledge, tools and call events are not applied) and then LiveVoiceModal opens on it.
   * Needs an agent name.
   */
  const startVoiceCall = async () => {
    if (!form.agentName.trim()) {
      toast.error("Give your agent a name first");
      return;
    }
    setVoiceTestStarting(true);
    const { data, error } = await api.startVoiceTest({
      name: form.agentName,
      voice: form.voice || null,
      language: form.language || null,
      system_prompt: form.systemPrompt || null,
      first_message: form.greeting || null,
    });
    setVoiceTestStarting(false);
    if (error || !data?.vapi_assistant_id) {
      toast.error(error || "Could not start the voice test");
      return;
    }
    // A throwaway VAPI assistant, never saved as a real agent — cleaned up when the call ends.
    setVoiceTestAgent({
      id: "voice-test",
      name: form.agentName,
      voice: form.voice,
      language: form.language,
      vapi_assistant_id: data.vapi_assistant_id,
    });
  };

  /**
   * `onOpenChange` handler for LiveVoiceModal. Ignores "open" events; when the modal closes it
   * clears the test agent and asks the backend to delete the temporary assistant
   * (DELETE /agents/test-voice/{id}). The request is not awaited, and the backend swallows
   * cleanup errors, so a failed delete is silent.
   */
  const endVoiceCall = (open: boolean) => {
    if (open) return;
    const assistantId = voiceTestAgent?.vapi_assistant_id;
    setVoiceTestAgent(null);
    if (assistantId) api.endVoiceTest(assistantId);
  };

  return (
    <div className="space-y-6">
      {!compact && (
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <PlayCircle className="h-7 w-7" />
          </div>
          <h3 className="mt-3 text-lg font-bold">Test Your Agent</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Try your agent before going live (optional, you can skip this step).
          </p>
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/20 p-4 text-center">
        <h4 className="text-sm font-semibold text-foreground">Talk to your agent</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Start a real live voice call with your agent, using its actual voice, prompt and language. No phone number needed.
        </p>
        <Button type="button" variant="outline" className="mt-3 gap-2" onClick={startVoiceCall} disabled={voiceTestStarting}>
          {voiceTestStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />}
          {voiceTestStarting ? "Starting…" : "Test with voice call"}
        </Button>
      </div>

      <div className="relative text-center text-xs text-muted-foreground">
        <span className="relative z-10 bg-background px-2">or test with a text message</span>
        <div className="absolute left-0 right-0 top-1/2 -z-0 border-t border-border" />
      </div>

      <Field label="Test Message">
        <textarea
          value={form.testMessage}
          onChange={(e) => update("testMessage", e.target.value)}
          rows={4}
          placeholder="Type a test prompt for your agent…"
          className="w-full rounded-md border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <Button type="button" onClick={runTest} disabled={loading || !form.testMessage.trim()}>
        <PlayCircle className="mr-2 h-4 w-4" />
        {loading ? "Testing…" : "Run test"}
      </Button>
      <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-sm">
        {loading ? (
          <span className="text-muted-foreground">Getting a response from your agent…</span>
        ) : reply ? (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent reply</div>
            <p className="whitespace-pre-wrap text-foreground">{reply}</p>
          </div>
        ) : (
          <span className="text-muted-foreground">The agent's response will appear here after you run a test.</span>
        )}
      </div>

      <LiveVoiceModal agent={voiceTestAgent} open={!!voiceTestAgent} onOpenChange={endVoiceCall} />
    </div>
  );
}

/** Labelled form row; wraps its control in a <label> and shows a red asterisk when `required`. */
export function Field({
  label, required, children, className,
}: { label: string; required?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-sm font-medium">
        {label} {required && <span className="text-destructive">*</span>}
      </span>
      {children}
    </label>
  );
}

/** Small uppercase section heading with an icon and a bottom rule, used inside the step forms. */
export function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      {icon}
      <h4 className="text-sm font-semibold uppercase tracking-wide text-foreground">{children}</h4>
    </div>
  );
}
