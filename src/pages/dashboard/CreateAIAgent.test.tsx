import "@/test/radix-stubs";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    analyzeAgentWebsite: vi.fn(), testAgent: vi.fn(), startVoiceTest: vi.fn(), endVoiceTest: vi.fn(),
    createAgent: vi.fn(), getCallEvents: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// The success overlay fires confetti on a canvas, which jsdom doesn't have.
vi.mock("canvas-confetti", () => ({ default: vi.fn() }));
// The live-call modal inside the Testing step loads the browser voice SDK; none of that is needed here.
vi.mock("@vapi-ai/web", () => ({
  default: class {
    on() {}
    start() { return Promise.resolve(); }
    stop() {}
    say() {}
    setMuted() {}
  },
}));

import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/services/api";
import { ALL_VOICE_NAMES } from "@/lib/voices";
import CreateAIAgent, { StepPrompt, StepSetup, StepTesting, type FormState } from "./CreateAIAgent";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

// jsdom has no Element.scrollTo, which the live-call modal's transcript calls as soon as it opens.
window.HTMLElement.prototype.scrollTo = vi.fn();

const BASE: FormState = {
  agentName: "", website: "", mainGoal: "", industry: "", language: "English", voice: "Elliot",
  transferEnabled: false, transferNumber: "", knowledgeText: "", systemPrompt: "", greeting: "",
  callEvents: [], toolKeys: [], testMessage: "",
};

/** Holds the form state the way the wizard does and prints the two fields these tests watch. */
function Harness({ step: Step, initial = {} }: { step: typeof StepSetup | typeof StepPrompt | typeof StepTesting; initial?: Partial<FormState> }) {
  const [form, setForm] = useState<FormState>({ ...BASE, ...initial });
  const update = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <>
      <Step form={form} update={update} />
      <pre data-testid="state">{JSON.stringify({ language: form.language, voice: form.voice })}</pre>
    </>
  );
}
const state = () => JSON.parse(screen.getByTestId("state").textContent || "{}") as { language: string; voice: string };

const languageField = () => screen.getByLabelText(/^Language/);
const voiceField = () => screen.getByLabelText(/^Voice/);

/** Opens a dropdown and picks the option with this exact text. */
async function choose(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => vi.clearAllMocks());

describe("Setup step: language dropdown", () => {
  it("offers English, Urdu, Spanish, German and Multilingual, in that order", async () => {
    render(<Harness step={StepSetup} />);
    fireEvent.click(languageField());
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["English", "Urdu", "Spanish", "German", "Multilingual (auto-detect)"]);
  });

  it("starts on English with the usual voice", () => {
    render(<Harness step={StepSetup} />);
    expect(state()).toEqual({ language: "English", voice: "Elliot" });
    expect(languageField()).toHaveTextContent("English");
  });

  it("saves Spanish and German as those exact labels", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Spanish");
    expect(state().language).toBe("Spanish");
    await choose(languageField(), "German");
    expect(state().language).toBe("German");
  });

  it("picking Spanish moves the English-only voice to Lucia, and German to Greta", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Spanish");
    expect(state()).toEqual({ language: "Spanish", voice: "Lucia" });
    expect(voiceField()).toHaveTextContent("Lucia");
    await choose(languageField(), "English");
    await choose(voiceField(), "Sid");
    await choose(languageField(), "German");
    expect(state()).toEqual({ language: "German", voice: "Greta" });
  });

  it("keeps a voice that can already speak the language", async () => {
    render(<Harness step={StepSetup} initial={{ voice: "Zara" }} />);
    await choose(languageField(), "Spanish");
    expect(state()).toEqual({ language: "Spanish", voice: "Zara" });
  });

  it("switching away from Spanish does not change the voice again", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Spanish");
    await choose(languageField(), "English");
    expect(state()).toEqual({ language: "English", voice: "Lucia" });
  });

  it("English and Urdu leave the voice exactly as it was", async () => {
    render(<Harness step={StepSetup} />);
    for (const label of ["Urdu", "English"]) {
      await choose(languageField(), label);
      expect(state().voice).toBe("Elliot");
    }
  });

  it("Multilingual moves an English-only voice to Zara, so the agent can speak Spanish, German and Urdu aloud", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Multilingual (auto-detect)");
    expect(state()).toEqual({ language: "Multilingual", voice: "Zara" });
    expect(voiceField()).toHaveTextContent("Zara");
  });

  it("Multilingual keeps a voice that can already speak other languages", async () => {
    render(<Harness step={StepSetup} initial={{ voice: "Mateo" }} />);
    await choose(languageField(), "Multilingual (auto-detect)");
    expect(state()).toEqual({ language: "Multilingual", voice: "Mateo" });
  });

  it("lists the Spanish and German voices next to the others", async () => {
    render(<Harness step={StepSetup} />);
    fireEvent.click(voiceField());
    const names = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(names).toEqual([...ALL_VOICE_NAMES]);
    for (const v of ["Lucia", "Mateo", "Greta", "Lukas", "Zara", "Ali", "Elliot"]) expect(names).toContain(v);
  });
});

describe("Setup step: note about a voice that can't speak the language", () => {
  it("says nothing for English with an English voice", () => {
    render(<Harness step={StepSetup} />);
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("says nothing right after switching to Spanish, because the voice already moved", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Spanish");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("explains the swap when an English-only voice is chosen for a Spanish agent", async () => {
    render(<Harness step={StepSetup} initial={{ language: "Spanish", voice: "Lucia" }} />);
    await choose(voiceField(), "Elliot");
    expect(screen.getByRole("note")).toHaveTextContent("Elliot only speaks English, so this Spanish agent will use Lucia instead.");
    await choose(voiceField(), "Mateo");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("tells a Multilingual agent with an English-only voice which voices can read other languages", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Multilingual (auto-detect)");
    // Switching to Multilingual already moved the voice to Zara, so there is nothing to say yet.
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await choose(voiceField(), "Elliot");
    expect(screen.getByRole("note")).toHaveTextContent(/pick a multilingual voice: Zara, Ali, Lucia, Mateo, Greta or Lukas/);
    await choose(voiceField(), "Zara");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("still shows the note for an existing Multilingual agent that has an English-only voice", () => {
    render(<Harness step={StepSetup} initial={{ language: "Multilingual", voice: "Elliot" }} />);
    expect(state()).toEqual({ language: "Multilingual", voice: "Elliot" });
    expect(screen.getByRole("note")).toHaveTextContent(/only speaks English/);
  });

  it("says nothing for Urdu, as before", async () => {
    render(<Harness step={StepSetup} />);
    await choose(languageField(), "Urdu");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });
});

describe("Prompt step: greeting", () => {
  it("shows an example greeting and a reminder in Spanish", () => {
    render(<Harness step={StepPrompt} initial={{ language: "Spanish" }} />);
    expect(screen.getByPlaceholderText("¡Hola! ¿En qué puedo ayudarle hoy?")).toBeInTheDocument();
    expect(screen.getByText("The greeting is spoken exactly as you write it, so write it in Spanish.")).toBeInTheDocument();
  });

  it("shows an example greeting and a reminder in German", () => {
    render(<Harness step={StepPrompt} initial={{ language: "German" }} />);
    expect(screen.getByPlaceholderText("Hallo! Wie kann ich Ihnen heute helfen?")).toBeInTheDocument();
    expect(screen.getByText("The greeting is spoken exactly as you write it, so write it in German.")).toBeInTheDocument();
  });

  it("is unchanged for English, Urdu and Multilingual", () => {
    for (const language of ["English", "Urdu", "Multilingual"]) {
      const { unmount } = render(<Harness step={StepPrompt} initial={{ language }} />);
      expect(screen.getByPlaceholderText("Hi! How can I help you today?")).toBeInTheDocument();
      expect(screen.queryByText(/spoken exactly as you write it/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("keeps whatever greeting was typed, untouched", () => {
    render(<Harness step={StepPrompt} initial={{ language: "Spanish", greeting: "Buenos días, Acme." }} />);
    expect(screen.getByDisplayValue("Buenos días, Acme.")).toBeInTheDocument();
  });
});

describe("Create agent page: what is saved", () => {
  /** Fills the wizard with the given language and presses Create Agent on the last step. */
  async function createAgentWith(language: string, greeting: string, placeholder: string) {
    fn(api.createAgent).mockResolvedValue({ data: { id: "new-1" }, error: null });
    fn(api.getCallEvents).mockResolvedValue({ data: [], error: null });
    render(<MemoryRouter><CreateAIAgent /></MemoryRouter>);

    // Step 1: setup
    fireEvent.change(screen.getByPlaceholderText("Enter your agent's name…"), { target: { value: "Sofia" } });
    fireEvent.change(screen.getByPlaceholderText("Describe what you want your agent to accomplish…"), { target: { value: "Book visits" } });
    fireEvent.click(screen.getByText("Select an industry…"));
    fireEvent.click(await screen.findByRole("option", { name: /Healthcare/ }));
    if (language !== "English") await choose(languageField(), language);
    const next = () => fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    next();
    // Step 2: knowledge (required when creating)
    fireEvent.change(await screen.findByPlaceholderText("Paste FAQs, product info, policies, scripts…"), { target: { value: "Open 9 to 5." } });
    next();
    // Step 3: prompt and greeting; the greeting's example text follows the language
    fireEvent.change(await screen.findByPlaceholderText("You are a friendly assistant who helps users with…"), { target: { value: "You are Sofia, a receptionist." } });
    fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value: greeting } });
    next();
    // Step 4: call events (none), step 5: testing, then create
    await waitFor(() => expect(api.getCallEvents).toHaveBeenCalled());
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledTimes(1));
    return fn(api.createAgent).mock.calls[0][0] as Record<string, unknown>;
  }

  it.each([
    ["Spanish", "Lucia", "¡Hola! ¿En qué puedo ayudarle hoy?", "Buenos días, Clínica Sol, ¿en qué puedo ayudarle?"],
    ["German", "Greta", "Hallo! Wie kann ich Ihnen heute helfen?", "Guten Tag, Praxis Sonne, wie kann ich Ihnen helfen?"],
  ])("a new %s agent is saved with that language, the %s voice and the greeting as typed", async (language, voice, placeholder, greeting) => {
    const body = await createAgentWith(language, greeting, placeholder);
    expect(body).toMatchObject({
      name: "Sofia", language, voice, first_message: greeting, system_prompt: "You are Sofia, a receptionist.",
      knowledge_text: "Open 9 to 5.", status: "Active",
    });
    expect(toast.error).not.toHaveBeenCalled();
    expect(await screen.findByText(/Go to My Agents/i)).toBeInTheDocument();
  });

  it("a new English agent is saved exactly as before", async () => {
    const body = await createAgentWith("English", "Thanks for calling.", "Hi! How can I help you today?");
    expect(body).toMatchObject({ language: "English", voice: "Elliot", first_message: "Thanks for calling." });
  });
});

describe("Testing step sends the language", () => {
  it("the text test includes the agent's language", async () => {
    fn(api.testAgent).mockResolvedValue({ data: { reply: "Claro que sí." }, error: null });
    render(<Harness step={StepTesting} initial={{ language: "Spanish", voice: "Lucia", systemPrompt: "p", greeting: "g", testMessage: "Hola" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Run test" }));
    await waitFor(() => expect(api.testAgent).toHaveBeenCalledTimes(1));
    expect(api.testAgent).toHaveBeenCalledWith({ message: "Hola", system_prompt: "p", first_message: "g", language: "Spanish" });
    expect(await screen.findByText("Claro que sí.")).toBeInTheDocument();
  });

  it("the live voice test includes the language and the voice", async () => {
    fn(api.startVoiceTest).mockResolvedValue({ data: { vapi_assistant_id: "asst-1" }, error: null });
    render(<Harness step={StepTesting} initial={{ agentName: "Sofia", language: "German", voice: "Greta", systemPrompt: "p", greeting: "Hallo" }} />);
    fireEvent.click(screen.getByRole("button", { name: /Test with voice call/ }));
    await waitFor(() => expect(api.startVoiceTest).toHaveBeenCalledTimes(1));
    expect(api.startVoiceTest).toHaveBeenCalledWith({
      name: "Sofia", voice: "Greta", language: "German", system_prompt: "p", first_message: "Hallo",
    });
  });
});
