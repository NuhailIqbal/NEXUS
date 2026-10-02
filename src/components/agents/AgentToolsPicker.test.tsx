import "@/test/radix-stubs";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { getToolPresets: vi.fn(), getCalendarStatus: vi.fn() } }));

import { api } from "@/services/api";
import { AgentToolsPicker, type ToolPreset } from "./AgentToolsPicker";

const presets: ToolPreset[] = [
  { key: "send_sms", label: "Send SMS", description: "Text the caller", requires: "a Twilio number" },
  { key: "check_availability", label: "Check Availability", description: "Find free times", requires: "a connected Google Calendar" },
  { key: "book_slot", label: "Book Calendar Slot", description: "Book a meeting", requires: "a connected Google Calendar" },
  { key: "update_crm", label: "Update CRM", description: "Update a contact", requires: null },
];
const calendar = (over = {}) => ({ configured: true, connected: true, status: "connected", email: "o@g.com", settings: {}, ...over });
const getPresets = api.getToolPresets as ReturnType<typeof vi.fn>;
const getCal = api.getCalendarStatus as ReturnType<typeof vi.fn>;

function Harness({ initial = [] as string[] }) {
  const [keys, setKeys] = useState<string[]>(initial);
  return (<><AgentToolsPicker selectedKeys={keys} onChange={setKeys} /><pre data-testid="keys">{JSON.stringify(keys)}</pre></>);
}
const keys = (): string[] => JSON.parse(screen.getByTestId("keys").textContent || "[]");

beforeEach(() => {
  vi.clearAllMocks();
  getPresets.mockResolvedValue({ data: presets, error: null });
  getCal.mockResolvedValue({ data: calendar(), error: null });
});

describe("AgentToolsPicker", () => {
  it("lists every tool with its description and what it needs", async () => {
    render(<Harness />);
    expect(screen.getByText(/Loading tools/)).toBeInTheDocument();
    expect(await screen.findByText("Send SMS")).toBeInTheDocument();
    expect(screen.getByText("Text the caller")).toBeInTheDocument();
    expect(screen.getByText("Needs a Twilio number")).toBeInTheDocument();
    expect(screen.queryByText(/Needs null/)).not.toBeInTheDocument();          // tools with no requirement show none
    expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  });

  it("ticks and unticks tools", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Send SMS" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Update CRM" }));
    expect(keys()).toEqual(["send_sms", "update_crm"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Send SMS" }));
    expect(keys()).toEqual(["update_crm"]);
  });

  it("starts with the agent's saved tools ticked", async () => {
    render(<Harness initial={["book_slot"]} />);
    expect(await screen.findByRole("checkbox", { name: "Book Calendar Slot" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Send SMS" })).not.toBeChecked();
  });

  it("two clicks in the same instant both count", async () => {
    render(<Harness initial={["send_sms"]} />);
    const a = await screen.findByRole("checkbox", { name: "Send SMS" });
    const b = screen.getByRole("checkbox", { name: "Update CRM" });
    const c = screen.getByRole("checkbox", { name: "Check Availability" });
    act(() => { a.click(); b.click(); c.click(); });
    expect(keys()).toEqual(["update_crm", "check_availability"]);
  });

  it("tip appears when booking is chosen without checking availability", async () => {
    render(<Harness />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Book Calendar Slot" }));
    expect(screen.getByText(/also tick “Check Availability”/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Check Availability" }));
    expect(screen.queryByText(/also tick “Check Availability”/)).not.toBeInTheDocument();
  });

  it("only looks up the calendar once a calendar tool is chosen", async () => {
    render(<Harness />);
    await screen.findByText("Send SMS");
    fireEvent.click(screen.getByRole("checkbox", { name: "Send SMS" }));
    expect(getCal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Check Availability" }));
    await waitFor(() => expect(getCal).toHaveBeenCalledTimes(1));
  });

  it("warns when a calendar tool is chosen but no calendar is connected", async () => {
    getCal.mockResolvedValue({ data: calendar({ connected: false, status: null }), error: null });
    render(<Harness initial={["book_slot"]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/No calendar is connected yet/);
    expect(screen.getByRole("link", { name: "Open Integrations" })).toHaveAttribute("href", "/dashboard/integrations");
  });

  it("warns when the connection needs to be reconnected", async () => {
    getCal.mockResolvedValue({ data: calendar({ status: "reauth_required" }), error: null });
    render(<Harness initial={["check_availability"]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/needs to be reconnected/);
  });

  it("no warning when the calendar is connected and healthy", async () => {
    render(<Harness initial={["book_slot", "check_availability"]} />);
    await screen.findByText("Book Calendar Slot");
    await waitFor(() => expect(getCal).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("no calendar warning for non-calendar tools", async () => {
    getCal.mockResolvedValue({ data: calendar({ connected: false }), error: null });
    render(<Harness initial={["send_sms"]} />);
    await screen.findByText("Send SMS");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("load failure shows an error with a working retry", async () => {
    getPresets.mockResolvedValueOnce({ data: null, error: "boom" });
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Send SMS")).toBeInTheDocument();
  });

  it("an empty tool list is handled", async () => {
    getPresets.mockResolvedValue({ data: [], error: null });
    render(<Harness />);
    expect(await screen.findByText("No tools are available.")).toBeInTheDocument();
  });
});
