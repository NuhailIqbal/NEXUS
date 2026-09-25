import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import {
  X, Check, Bot, BookOpen, FileText, PlayCircle, Sparkles, Briefcase,
  ArrowLeft, ArrowRight, Upload, Trash2, Info, Loader2, Phone,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, isE164 } from "@/lib/utils";
import { ALL_VOICE_NAMES } from "@/lib/voices";
import { api } from "@/services/api";
import { AgentCreatedSuccessModal } from "@/components/dashboard/AgentCreatedSuccessModal";
import { LiveVoiceModal, VoiceAgentInfo } from "@/components/dashboard/LiveVoiceModal";
import { IndustryCombobox } from "@/components/dashboard/IndustryCombobox";

type StepKey = "setup" | "knowledge" | "prompt" | "testing";

const STEPS: { key: StepKey; title: string; description: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "setup", title: "Complete Setup", description: "Basic agent configuration and tools", icon: Bot },
  { key: "knowledge", title: "Knowledge Center", description: "Upload knowledge sources", icon: BookOpen },
  { key: "prompt", title: "Prompt Studio", description: "Craft the agent's instructions", icon: FileText },
  { key: "testing", title: "Testing", description: "Test before going live", icon: PlayCircle },
];

type FormState = {
  agentName: string;
  website: string;
  mainGoal: string;
  industry: string;
  language: string;
  voice: string;
  transferEnabled: boolean;
  transferNumber: string;
  knowledgeText: string;
  knowledgeFiles: File[];
  systemPrompt: string;
  greeting: string;
  testMessage: string;
};

const KNOWLEDGE_TEXT_LIMIT = 8000;
const KNOWLEDGE_FILE_MAX_MB = 10;
const KNOWLEDGE_FILE_TYPES = [".pdf", ".txt", ".md", ".doc", ".docx"];

const CreateAIAgent = () => {
  const navigate = useNavigate();
  const [stepIndex, setStepIndex] = useState(0);
  const [showSuccess, setShowSuccess] = useState(false);
  const [completed, setCompleted] = useState<Record<StepKey, boolean>>({
    setup: false, knowledge: false, prompt: false, testing: false,
  });
  const [form, setForm] = useState<FormState>({
    agentName: "", website: "", mainGoal: "", transferEnabled: false, transferNumber: "", industry: "", language: "English", voice: "Elliot",
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
      if (form.transferEnabled && !form.transferNumber.trim()) { toast.error("Enter a transfer number or turn off call transfer"); return false; }
      if (form.transferEnabled && !isE164(form.transferNumber)) { toast.error("Transfer number must be in international format, e.g. +15551234567"); return false; }
      if (!form.industry) { toast.error("Please select an industry"); return false; }
    }
    if (currentStep.key === "knowledge") {
      const hasText = form.knowledgeText.trim().length > 0;
      const hasFiles = form.knowledgeFiles.length > 0;
      if (!hasText && !hasFiles) {
        toast.error("Add knowledge text or upload at least one file before continuing");
        return false;
      }
      if (form.knowledgeText.length > KNOWLEDGE_TEXT_LIMIT) {
        toast.error(`Knowledge text exceeds ${KNOWLEDGE_TEXT_LIMIT.toLocaleString()} characters upload as a file instead`);
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
      transfer_number: form.transferEnabled ? (form.transferNumber.trim() || null) : null,
      knowledge_text: form.knowledgeText || null,
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
  const voiceOptions = ALL_VOICE_NAMES;
  const [analyzing, setAnalyzing] = useState(false);

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
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-primary border-primary/30"
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
            <Select value={form.language} onValueChange={(v) => update("language", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="English">English</SelectItem>
                <SelectItem value="Urdu">Urdu</SelectItem>
                <SelectItem value="Multilingual">Multilingual (auto-detect)</SelectItem>
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
          </Field>
        </div>
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
              <li><span className="font-medium text-foreground">Paste text</span> short FAQs, key policies, scripts (under {KNOWLEDGE_TEXT_LIMIT.toLocaleString()} characters). Goes straight into the agent's instructions, available instantly on every call.</li>
              <li><span className="font-medium text-foreground">Upload files</span> product catalogs, full manuals, large documents. The agent retrieves relevant sections during the call.</li>
            </ul>
            <p className="text-xs text-muted-foreground">You can use one or both. At least one is required.</p>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Quick Text <span className="text-xs font-normal text-muted-foreground">  short content</span></span>
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
        <span className="block text-sm font-medium">Knowledge Files <span className="text-xs font-normal text-muted-foreground">  large content</span></span>
        <label
          htmlFor="knowledge-file-input"
          className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-input bg-muted/30 px-4 py-8 text-center transition hover:border-primary/40 hover:bg-muted/50"
        >
          <Upload className="h-6 w-6 text-muted-foreground" />
          <div className="text-sm font-medium">Click to upload or drag files here</div>
          <div className="text-xs text-muted-foreground">
            {KNOWLEDGE_FILE_TYPES.join(", ")} up to {KNOWLEDGE_FILE_MAX_MB}MB each
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
  const [reply, setReply] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [voiceTestAgent, setVoiceTestAgent] = useState<VoiceAgentInfo | null>(null);
  const [voiceTestStarting, setVoiceTestStarting] = useState(false);

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
    });
    setLoading(false);
    if (error) {
      toast.error(error);
      return;
    }
    setReply(data?.reply ?? "");
  };

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

  const endVoiceCall = (open: boolean) => {
    if (open) return;
    const assistantId = voiceTestAgent?.vapi_assistant_id;
    setVoiceTestAgent(null);
    if (assistantId) api.endVoiceTest(assistantId);
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PlayCircle className="h-7 w-7" />
        </div>
        <h3 className="mt-3 text-lg font-bold">Test Your Agent</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Try your agent before going live (optional, you can skip this step).
        </p>
      </div>

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
