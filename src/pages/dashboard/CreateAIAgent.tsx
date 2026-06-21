import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  X, Check, Bot, Wrench, BookOpen, FileText, PlayCircle, Sparkles,
  ShoppingBag, HeartPulse, Landmark, Home, GraduationCap, Plane, Briefcase, Building2,
  ArrowLeft, ArrowRight, Upload, Trash2, Info,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { AgentCreatedSuccessModal } from "@/components/dashboard/AgentCreatedSuccessModal";

type StepKey = "setup" | "tools" | "knowledge" | "prompt" | "testing";

const STEPS: { key: StepKey; title: string; description: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "setup", title: "Complete Setup", description: "Basic agent configuration and tools", icon: Bot },
  { key: "tools", title: "AI Tools", description: "Connect tools your agent can use", icon: Wrench },
  { key: "knowledge", title: "Knowledge Center", description: "Upload knowledge sources", icon: BookOpen },
  { key: "prompt", title: "Prompt Studio", description: "Craft the agent's instructions", icon: FileText },
  { key: "testing", title: "Testing", description: "Test before going live", icon: PlayCircle },
];

const INDUSTRIES = [
  { id: "retail", label: "Retail & E-commerce", icon: ShoppingBag, color: "bg-orange-500/15 text-orange-400" },
  { id: "health", label: "Healthcare & Medical", icon: HeartPulse, color: "bg-rose-500/15 text-rose-400" },
  { id: "finance", label: "Finance & Banking", icon: Landmark, color: "bg-emerald-500/15 text-emerald-400" },
  { id: "realestate", label: "Real Estate", icon: Home, color: "bg-amber-500/15 text-amber-400" },
  { id: "education", label: "Education", icon: GraduationCap, color: "bg-blue-500/15 text-blue-400" },
  { id: "travel", label: "Travel & Hospitality", icon: Plane, color: "bg-cyan-500/15 text-cyan-400" },
  { id: "saas", label: "SaaS & Technology", icon: Briefcase, color: "bg-violet-500/15 text-violet-400" },
  { id: "other", label: "Other", icon: Building2, color: "bg-slate-500/15 text-slate-400" },
];

type FormState = {
  agentName: string;
  website: string;
  mainGoal: string;
  industry: string;
  language: string;
  voice: string;
  selectedTools: string[];
  knowledgeText: string;
  knowledgeFiles: File[];
  systemPrompt: string;
  greeting: string;
  testMessage: string;
};

const KNOWLEDGE_TEXT_LIMIT = 8000;
const KNOWLEDGE_FILE_MAX_MB = 10;
const KNOWLEDGE_FILE_TYPES = [".pdf", ".txt", ".md", ".doc", ".docx"];

const TOOLS_OPTIONS = [
  { id: "send_email", label: "Send Email", desc: "Send transactional emails" },
  { id: "book_slot", label: "Book Calendar Slot", desc: "Schedule meetings" },
  { id: "update_crm", label: "Update CRM", desc: "Sync contact updates" },
  { id: "send_sms", label: "Send SMS", desc: "Send SMS via Twilio" },
  { id: "webhook", label: "Webhook Trigger", desc: "POST payload to URL" },
];

const CreateAIAgent = () => {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);
  const [completed, setCompleted] = useState<Record<StepKey, boolean>>({
    setup: false, tools: false, knowledge: false, prompt: false, testing: false,
  });
  const [form, setForm] = useState<FormState>({
    agentName: "", website: "", mainGoal: "", industry: "", language: "English (US)", voice: "Aria",
    selectedTools: [],
    knowledgeText: "",
    knowledgeFiles: [],
    systemPrompt: "", greeting: "",
    testMessage: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const currentStep = STEPS[stepIndex];
  const completedCount = Object.values(completed).filter(Boolean).length;

  const close = () => navigate("/dashboard/ai-agents");

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const validate = (): boolean => {
    if (currentStep.key === "setup") {
      if (!form.agentName.trim()) { toast.error("Agent name is required"); return false; }
      if (!form.mainGoal.trim()) { toast.error("Main goal is required"); return false; }
      if (!form.industry) { toast.error("Please select an industry"); return false; }
    }
    if (currentStep.key === "tools" && form.selectedTools.length === 0) {
      toast.error("Select at least one tool");
      return false;
    }
    if (currentStep.key === "knowledge") {
      const hasText = form.knowledgeText.trim().length > 0;
      const hasFiles = form.knowledgeFiles.length > 0;
      if (!hasText && !hasFiles) {
        toast.error("Add knowledge text or upload at least one file before continuing");
        return false;
      }
      if (form.knowledgeText.length > KNOWLEDGE_TEXT_LIMIT) {
        toast.error(`Knowledge text exceeds ${KNOWLEDGE_TEXT_LIMIT.toLocaleString()} characters — upload as a file instead`);
        return false;
      }
    }
    if (currentStep.key === "prompt") {
      if (!form.systemPrompt.trim()) { toast.error("System prompt is required"); return false; }
      if (!form.greeting.trim()) { toast.error("Greeting message is required"); return false; }
    }
    if (currentStep.key === "testing" && !form.testMessage.trim()) {
      toast.error("Send a test message to validate the agent");
      return false;
    }
    return true;
  };

  const persistToApi = async () => {
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
      knowledge_text: form.knowledgeText || null,
      selected_tool_keys: form.selectedTools,
    });
    if (error || !data?.id) {
      toast.error(error || "Failed to create agent");
      return false;
    }

    if (form.knowledgeFiles.length > 0) {
      let failed = 0;
      for (const file of form.knowledgeFiles) {
        const res = await api.uploadAgentKnowledge(data.id, file);
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

  const back = () => stepIndex > 0 && setStepIndex(stepIndex - 1);

  const goToStep = (i: number) => {
    if (i <= stepIndex || completed[STEPS[i].key]) setStepIndex(i);
    else toast.error("Complete the current step first");
  };

  return (
    <div className="-mx-4 -my-6 min-h-[calc(100vh-4rem)] bg-muted/30 sm:-mx-6 lg:-mx-8">
      <div className="sticky top-16 z-20 flex items-center justify-between border-b border-border bg-background px-6 py-4">
        <div>
          <h1 className="bg-gradient-to-r from-primary to-emerald-400 bg-clip-text text-2xl font-bold text-transparent">
            Create AI Agent
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Link to="/dashboard/ai-agents" className="hover:text-primary">AI Agents</Link>
            <span>/</span>
            <span>Create AI Agent</span>
            <span>/</span>
            <span className="text-foreground font-medium">{currentStep.title}</span>
          </div>
        </div>
        <button
          onClick={close}
          className="rounded-md p-2 text-muted-foreground hover:bg-muted"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-[280px_1fr]">
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

          <ul className="space-y-2">
            {STEPS.map((s, i) => {
              const isActive = i === stepIndex;
              const isDone = completed[s.key];
              return (
                <li key={s.key}>
                  <button
                    onClick={() => goToStep(i)}
                    className={cn(
                      "flex w-full items-start gap-3 rounded-xl border p-3 text-left transition",
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
                    <div className="min-w-0 flex-1">
                      <div className={cn("text-sm font-medium", isActive ? "text-foreground" : "text-muted-foreground")}>
                        {s.title}
                      </div>
                      {isActive && (
                        <div className="mt-0.5 text-xs text-muted-foreground">{s.description}</div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <div className="mb-6">
            <h2 className="text-xl font-bold">
              {currentStep.title} <span className="ml-1 text-sm font-normal text-muted-foreground">Step {stepIndex + 1} of {STEPS.length}</span>
            </h2>
            <p className="text-sm text-muted-foreground">{currentStep.description}</p>
          </div>

          <div className="rounded-xl border border-border bg-background p-6">
            {currentStep.key === "setup" && <StepSetup form={form} update={update} />}
            {currentStep.key === "tools" && <StepTools form={form} update={update} />}
            {currentStep.key === "knowledge" && <StepKnowledge form={form} update={update} />}
            {currentStep.key === "prompt" && <StepPrompt form={form} update={update} />}
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

function StepSetup({
  form, update,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void }) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Bot className="h-7 w-7" />
        </div>
        <h3 className="mt-3 text-lg font-bold">Complete Agent Setup</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure your agent's basic information, purpose, and communication settings
        </p>
      </div>

      <div>
        <SectionTitle icon={<Bot className="h-4 w-4 text-primary" />}>Basic Information</SectionTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
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
                className="h-10 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
              />
              <Button type="button" variant="outline" size="sm" className="text-primary border-primary/30">
                <Sparkles className="mr-1 h-3.5 w-3.5" /> Analyze
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
      </div>

      <div>
        <SectionTitle icon={<Briefcase className="h-4 w-4 text-primary" />}>Business Context</SectionTitle>
        <Field label="Industry" required className="mt-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {INDUSTRIES.map((ind) => {
              const Icon = ind.icon;
              const active = form.industry === ind.id;
              return (
                <button
                  key={ind.id}
                  type="button"
                  onClick={() => update("industry", ind.id)}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-xl border p-4 text-center text-sm transition",
                    active
                      ? "border-primary bg-primary/5 text-foreground shadow-sm"
                      : "border-input hover:border-primary/40 hover:bg-muted/40",
                  )}
                >
                  <span className={cn("flex h-10 w-10 items-center justify-center rounded-lg", ind.color)}>
                    <Icon className="h-5 w-5" />
                  </span>
                  <span className="font-medium leading-tight">{ind.label}</span>
                </button>
              );
            })}
          </div>
        </Field>
      </div>

      <div>
        <SectionTitle icon={<Sparkles className="h-4 w-4 text-primary" />}>Communication</SectionTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Language">
            <select
              value={form.language}
              onChange={(e) => update("language", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option>English (US)</option><option>English (UK)</option>
              <option>Spanish (ES)</option><option>French (FR)</option>
              <option>German (DE)</option><option>Italian (IT)</option>
            </select>
          </Field>
          <Field label="Voice">
            <select
              value={form.voice}
              onChange={(e) => update("voice", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option>Aria</option><option>Marco</option><option>Nora</option>
              <option>Kai</option><option>Eva</option><option>Tom</option>
            </select>
          </Field>
        </div>
      </div>
    </div>
  );
}

function StepTools({
  form, update,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void }) {
  const toggle = (id: string) => {
    const next = form.selectedTools.includes(id)
      ? form.selectedTools.filter((t) => t !== id)
      : [...form.selectedTools, id];
    update("selectedTools", next);
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Wrench className="h-7 w-7" />
        </div>
        <h3 className="mt-3 text-lg font-bold">Connect AI Tools</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Select tools your agent can use during conversations
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {TOOLS_OPTIONS.map((t) => {
          const active = form.selectedTools.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => toggle(t.id)}
              className={cn(
                "flex items-start gap-3 rounded-xl border p-4 text-left transition",
                active ? "border-primary bg-primary/5" : "border-input hover:bg-muted/40",
              )}
            >
              <span className={cn(
                "mt-0.5 flex h-5 w-5 items-center justify-center rounded border",
                active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/30",
              )}>
                {active && <Check className="h-3 w-3" />}
              </span>
              <div>
                <div className="font-medium">{t.label}</div>
                <div className="text-xs text-muted-foreground">{t.desc}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepKnowledge({
  form, update,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void }) {
  const textLen = form.knowledgeText.length;
  const textOver = textLen > KNOWLEDGE_TEXT_LIMIT;

  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const accepted: File[] = [];
    Array.from(files).forEach((f) => {
      const sizeMb = f.size / (1024 * 1024);
      const ext = "." + (f.name.split(".").pop() || "").toLowerCase();
      if (sizeMb > KNOWLEDGE_FILE_MAX_MB) {
        toast.error(`${f.name} exceeds ${KNOWLEDGE_FILE_MAX_MB}MB limit`);
        return;
      }
      if (!KNOWLEDGE_FILE_TYPES.includes(ext)) {
        toast.error(`${f.name}: unsupported file type (${KNOWLEDGE_FILE_TYPES.join(", ")})`);
        return;
      }
      accepted.push(f);
    });
    update("knowledgeFiles", [...form.knowledgeFiles, ...accepted]);
  };

  const removeFile = (i: number) => {
    update("knowledgeFiles", form.knowledgeFiles.filter((_, idx) => idx !== i));
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <BookOpen className="h-7 w-7" />
        </div>
        <h3 className="mt-3 text-lg font-bold">Knowledge Center</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Give your agent the info it needs to answer accurately
        </p>
      </div>

      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
        <div className="flex items-start gap-2.5">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="space-y-2 text-sm">
            <p className="font-semibold text-foreground">When to use what</p>
            <ul className="space-y-1 text-muted-foreground">
              <li><span className="font-medium text-foreground">Paste text</span> — short FAQs, key policies, scripts (under {KNOWLEDGE_TEXT_LIMIT.toLocaleString()} characters). Goes straight into the agent's instructions, available instantly on every call.</li>
              <li><span className="font-medium text-foreground">Upload files</span> — product catalogs, full manuals, large documents. The agent retrieves relevant sections during the call.</li>
            </ul>
            <p className="text-xs text-muted-foreground">You can use one or both. At least one is required.</p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Quick Text <span className="text-xs font-normal text-muted-foreground">— short content</span></span>
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
            This is too long for quick text. Save it as a .txt or .pdf file and upload it below instead.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <span className="block text-sm font-medium">Knowledge Files <span className="text-xs font-normal text-muted-foreground">— large content</span></span>
        <label
          htmlFor="knowledge-file-input"
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-input bg-muted/30 px-4 py-8 text-center transition hover:border-primary/40 hover:bg-muted/50"
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          <div className="text-sm font-medium">Click to upload or drag files here</div>
          <div className="text-xs text-muted-foreground">
            {KNOWLEDGE_FILE_TYPES.join(", ")} — up to {KNOWLEDGE_FILE_MAX_MB}MB each
          </div>
          <input
            id="knowledge-file-input"
            type="file"
            multiple
            accept={KNOWLEDGE_FILE_TYPES.join(",")}
            className="hidden"
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>

        {form.knowledgeFiles.length > 0 && (
          <ul className="space-y-2">
            {form.knowledgeFiles.map((f, i) => (
              <li
                key={`${f.name}-${i}`}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-primary" />
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => removeFile(i)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Remove ${f.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StepPrompt({
  form, update,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <FileText className="h-7 w-7" />
        </div>
        <h3 className="mt-3 text-lg font-bold">Prompt Studio</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Define how your agent thinks and speaks
        </p>
      </div>
      <Field label="System Prompt" required>
        <textarea
          value={form.systemPrompt}
          onChange={(e) => update("systemPrompt", e.target.value)}
          rows={6}
          placeholder="You are a friendly assistant who helps users with…"
          className="w-full rounded-md border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <Field label="Greeting Message" required>
        <input
          value={form.greeting}
          onChange={(e) => update("greeting", e.target.value)}
          placeholder="Hi! How can I help you today?"
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
    </div>
  );
}

function StepTesting({
  form, update,
}: { form: FormState; update: <K extends keyof FormState>(k: K, v: FormState[K]) => void }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PlayCircle className="h-7 w-7" />
        </div>
        <h3 className="mt-3 text-lg font-bold">Test Your Agent</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Send a sample message to verify everything works as expected
        </p>
      </div>
      <Field label="Test Message" required>
        <textarea
          value={form.testMessage}
          onChange={(e) => update("testMessage", e.target.value)}
          rows={4}
          placeholder="Type a test prompt for your agent…"
          className="w-full rounded-md border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        />
      </Field>
      <div className="rounded-lg border border-dashed border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        Mock response will appear here once the agent goes live.
      </div>
    </div>
  );
}

function Field({
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

function SectionTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border pb-2">
      {icon}
      <h4 className="text-sm font-semibold uppercase tracking-wide text-foreground">{children}</h4>
    </div>
  );
}
