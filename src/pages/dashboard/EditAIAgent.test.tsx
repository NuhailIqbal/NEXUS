import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getAgent: vi.fn(), getAgentEvents: vi.fn(), updateAgent: vi.fn(), getCallEvents: vi.fn(),
    createCallEvent: vi.fn(), updateCallEvent: vi.fn(), deleteCallEvent: vi.fn(),
    analyzeAgentWebsite: vi.fn(), testAgent: vi.fn(), startVoiceTest: vi.fn(), endVoiceTest: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@vapi-ai/web", () => ({
  default: class {
    on() {}
    start() { return Promise.resolve(); }
    stop() {}
    say() {}
    setMuted() {}
  },
}));

import { api } from "@/services/api";
import EditAgentModal from "./EditAIAgent";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const onClose = vi.fn();
const onSaved = vi.fn();

const agent = (over: Record<string, unknown> = {}) => ({
  id: "a1", name: "Sofia", status: "Active", voice: "Lucia", language: "Spanish", category: "Healthcare",
  system_prompt: "You are Sofia.", first_message: "Hola", main_goal: "Book visits", website: null,
  transfer_number: null, selected_tool_keys: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fn(api.getAgentEvents).mockResolvedValue({ data: [], error: null });
  fn(api.getCallEvents).mockResolvedValue({ data: [], error: null });
  fn(api.updateAgent).mockResolvedValue({ data: {}, error: null });
});

async function open(over: Record<string, unknown> = {}) {
  fn(api.getAgent).mockResolvedValue({ data: agent(over), error: null });
  const view = render(<EditAgentModal agentId="a1" onClose={onClose} onSaved={onSaved} />);
  await screen.findByText("Edit AI Agent");
  return view;
}

const languageField = () => screen.getByLabelText(/^Language/);
const voiceField = () => screen.getByLabelText(/^Voice/);

async function choose(trigger: HTMLElement, option: string) {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

/** Walks through the five steps with Continue and presses Save; returns the body sent to the API. */
async function save(): Promise<Record<string, unknown>> {
  for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Save Changes" }));
  await waitFor(() => expect(api.updateAgent).toHaveBeenCalledTimes(1));
  const [id, body] = fn(api.updateAgent).mock.calls[0];
  expect(id).toBe("a1");
  return body;
}

describe("Edit agent: the language shown", () => {
  it("shows a Spanish agent as Spanish with its voice", async () => {
    await open({ language: "Spanish", voice: "Lucia" });
    expect(languageField()).toHaveTextContent("Spanish");
    expect(voiceField()).toHaveTextContent("Lucia");
  });

  it("shows a German agent as German", async () => {
    await open({ language: "German", voice: "Lukas" });
    expect(languageField()).toHaveTextContent("German");
    expect(voiceField()).toHaveTextContent("Lukas");
  });

  it.each([
    ["Spanish (ES)", "Spanish"], ["Spanish (MX)", "Spanish"], ["German (DE)", "German"], ["es", "Spanish"], ["de-DE", "German"],
    ["English", "English"], ["English (US)", "English"], ["Urdu", "Urdu"], ["Urdu (PK)", "Urdu"],
    ["Multilingual", "Multilingual (auto-detect)"], [null, "English"],
  ])("a stored %s shows as %s", async (stored, shown) => {
    await open({ language: stored, voice: "Zara" });
    expect(languageField()).toHaveTextContent(shown);
  });
});

describe("Edit agent: saving keeps the language", () => {
  it("a Spanish agent saved as it is stays Spanish with the same voice", async () => {
    await open({ language: "Spanish", voice: "Mateo" });
    const body = await save();
    expect(body).toMatchObject({ language: "Spanish", voice: "Mateo", name: "Sofia" });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a German agent saved as it is stays German", async () => {
    await open({ language: "German", voice: "Greta" });
    expect(await save()).toMatchObject({ language: "German", voice: "Greta" });
  });

  it("an older 'Spanish (ES)' agent is saved as Spanish rather than turning into English", async () => {
    await open({ language: "Spanish (ES)", voice: "Lucia" });
    expect(await save()).toMatchObject({ language: "Spanish" });
  });

  it("switching an English agent to Spanish moves the voice to Lucia and saves both", async () => {
    await open({ language: "English", voice: "Elliot" });
    await choose(languageField(), "Spanish");
    expect(voiceField()).toHaveTextContent("Lucia");
    expect(await save()).toMatchObject({ language: "Spanish", voice: "Lucia" });
  });

  it("switching to German keeps a voice that can already speak it", async () => {
    await open({ language: "English", voice: "Zara" });
    await choose(languageField(), "German");
    expect(await save()).toMatchObject({ language: "German", voice: "Zara" });
  });

  it("switching a Spanish agent back to English saves English and keeps its voice", async () => {
    await open({ language: "Spanish", voice: "Lucia" });
    await choose(languageField(), "English");
    expect(await save()).toMatchObject({ language: "English", voice: "Lucia" });
  });
});

describe("Edit agent: the existing languages save exactly what they did before", () => {
  it.each([
    ["English", "Elliot", "English", "Elliot"],
    ["English (US)", "Naina", "English", "Naina"],
    ["Urdu", "Zara", "Urdu", "Zara"],
    ["Urdu (PK)", "Ali", "Urdu", "Ali"],
    ["Multilingual", "Elliot", "Multilingual", "Elliot"],
  ])("%s with voice %s is saved as %s with voice %s", async (stored, voice, language, savedVoice) => {
    await open({ language: stored, voice });
    expect(await save()).toMatchObject({ language, voice: savedVoice });
  });
});
