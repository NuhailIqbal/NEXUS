import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/services/api", () => ({ api: { getAgents: vi.fn(), createAgent: vi.fn(), getAgentEvents: vi.fn(), deleteAgent: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The two modals the page can open load the browser voice SDK and the wizard; neither is under test here.
vi.mock("@/components/dashboard/LiveVoiceModal", () => ({ LiveVoiceModal: () => null }));
vi.mock("./EditAIAgent", () => ({ default: () => null }));

import { api } from "@/services/api";
import AIAgents from "./AIAgents";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const agent = (over: Record<string, unknown>) => ({
  id: "a", name: "Agent", status: "Active", voice: "Elliot", language: "English", category: "Sales",
  created_at: "2026-10-01T00:00:00Z", phone_numbers: [], ...over,
});

async function show(agents: unknown[]) {
  fn(api.getAgents).mockResolvedValue({ data: agents, error: null });
  render(<MemoryRouter><AIAgents /></MemoryRouter>);
  await waitFor(() => expect(api.getAgents).toHaveBeenCalled());
}
const card = (name: string) => screen.getByRole("heading", { name }).closest("div.flex.flex-col") as HTMLElement;

beforeEach(() => vi.clearAllMocks());

describe("Agent card: connected phone number", () => {
  it("shows the number connected to the agent", async () => {
    await show([agent({ id: "a1", name: "Sofia", phone_numbers: [{ id: "n1", number: "+15551230001", label: "Main line" }] })]);
    const c = within(card("Sofia"));
    expect(await c.findByText("Phone")).toBeInTheDocument();
    expect(c.getByText("+15551230001")).toBeInTheDocument();
    expect(c.getByText("+15551230001")).toHaveAttribute("title", "+15551230001 (Main line)");
  });

  it("lists several numbers on one line", async () => {
    await show([agent({ id: "a1", name: "Sofia", phone_numbers: [{ id: "n1", number: "+15551230001" }, { id: "n2", number: "+15551230002" }] })]);
    expect(await within(card("Sofia")).findByText("+15551230001, +15551230002")).toBeInTheDocument();
  });

  it("says Not connected for an agent without a number, and each agent shows its own", async () => {
    await show([
      agent({ id: "a1", name: "Sofia", phone_numbers: [{ id: "n1", number: "+15551230001" }] }),
      agent({ id: "a2", name: "Max" }),
    ]);
    expect(await within(card("Max")).findByText("Not connected")).toBeInTheDocument();
    expect(within(card("Sofia")).queryByText("Not connected")).toBeNull();
    expect(within(card("Max")).queryByText("+15551230001")).toBeNull();
  });

  it("copes with an older response that has no phone_numbers at all", async () => {
    await show([agent({ id: "a1", name: "Sofia", phone_numbers: undefined })]);
    expect(await within(card("Sofia")).findByText("Not connected")).toBeInTheDocument();
  });

  it("a duplicate keeps the original's call timeout", async () => {
    fn(api.getAgentEvents).mockResolvedValue({ data: [], error: null });
    fn(api.createAgent).mockResolvedValue({ data: { id: "copy" }, error: null });
    await show([agent({ id: "a1", name: "Sofia", call_timeout_minutes: 25 })]);
    fireEvent.click(await within(card("Sofia")).findByTitle("Duplicate"));
    fireEvent.click(await screen.findByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(api.createAgent).toHaveBeenCalledTimes(1));
    expect(fn(api.createAgent).mock.calls[0][0]).toMatchObject({ name: "Sofia (Copy)", call_timeout_minutes: 25 });
  });
});
