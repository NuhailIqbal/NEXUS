import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/services/api", () => ({
  api: {
    getAgents: vi.fn(), getPhoneNumbers: vi.fn(), getContacts: vi.fn(), getCampaigns: vi.fn(),
    getInboundQueues: vi.fn(), getConversations: vi.fn(),
  },
}));

import { api } from "@/services/api";
import QuickSetup from "./QuickSetup";

const m = (fn: unknown) => fn as ReturnType<typeof vi.fn>;
const rows = (n: number, extra: Record<string, unknown> = {}) =>
  Promise.resolve({ data: Array.from({ length: n }, () => ({ id: "x", ...extra })), error: null });

type Have = Partial<Record<"agents" | "numbers" | "contacts" | "campaigns" | "receptionists" | "out" | "in", number>> & { connected?: boolean };

const setup = (h: Have = {}) => {
  m(api.getAgents).mockReturnValue(rows(h.agents ?? 0));
  m(api.getPhoneNumbers).mockReturnValue(rows(h.numbers ?? 0));
  m(api.getContacts).mockReturnValue(rows(h.contacts ?? 0));
  m(api.getCampaigns).mockReturnValue(rows(h.campaigns ?? 0));
  m(api.getInboundQueues).mockReturnValue(rows(h.receptionists ?? 0, h.connected ? { phone_number_id: "p1" } : {}));
  m(api.getConversations).mockImplementation((q: string) => rows(q.includes("direction=outbound") ? h.out ?? 0 : h.in ?? 0));
  return render(<MemoryRouter><QuickSetup /></MemoryRouter>);
};

beforeEach(() => vi.clearAllMocks());

describe("QuickSetup", () => {
  it("starts a new account on Outbound with the first step up next", async () => {
    setup();
    expect(await screen.findByText("Outbound checklist")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Quick Setup" })).toBeTruthy();
    expect(screen.getByText("0 of 5 steps")).toBeTruthy();
    const next = screen.getByText("Up next").parentElement as HTMLElement;
    expect(within(next).getByText("Create your first AI agent")).toBeTruthy();
    expect(within(next).getByRole("link", { name: /Continue/ }).getAttribute("href")).toBe("/dashboard/ai-agents/create");
  });

  it("moves 'up next' to the first unfinished step", async () => {
    setup({ agents: 1, numbers: 2, contacts: 3 });
    await screen.findByText("Outbound checklist");
    expect(screen.getByText("3 of 5 steps")).toBeTruthy();
    const next = screen.getByText("Up next").parentElement as HTMLElement;
    expect(within(next).getByText("Launch your first campaign")).toBeTruthy();
    expect(screen.getAllByText("Done")).toHaveLength(3);
  });

  it("shows the inbound checklist, and a number only counts once it is on a receptionist", async () => {
    setup({ agents: 1, numbers: 1, receptionists: 1, connected: false });
    await screen.findByText("Outbound checklist");
    fireEvent.click(screen.getByRole("button", { name: /Inbound/ }));
    expect(screen.getByText("Inbound checklist")).toBeTruthy();
    expect(screen.getByText("3 of 5 steps")).toBeTruthy();
    const next = screen.getByText("Up next").parentElement as HTMLElement;
    expect(within(next).getByText("Connect a number to it")).toBeTruthy();
  });

  it("opens on Inbound once Outbound is complete and offers the other track when a track finishes", async () => {
    setup({ agents: 1, numbers: 1, contacts: 1, campaigns: 1, out: 1 });
    expect(await screen.findByText("Inbound checklist")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Outbound/ }));
    expect(screen.getByText("Outbound is ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Set up Inbound/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Set up Inbound/ }));
    await waitFor(() => expect(screen.getByText("Inbound checklist")).toBeTruthy());
  });

  it("congratulates when both tracks are complete", async () => {
    setup({ agents: 1, numbers: 1, contacts: 1, campaigns: 1, out: 1, receptionists: 1, connected: true, in: 1 });
    await screen.findByText("Outbound checklist");
    expect(screen.getAllByText("Complete")).toHaveLength(2);
    expect(screen.getByText("Calling is fully set up. Review anything below any time.")).toBeTruthy();
    expect(screen.getByText("Both tracks are finished. Nice work.")).toBeTruthy();
  });
});
