import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getCallEvents: vi.fn(), createCallEvent: vi.fn(), updateCallEvent: vi.fn(), deleteCallEvent: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import CallEvents from "./CallEvents";
import type { LibraryEvent } from "@/components/agents/callEventTypes";

const get = api.getCallEvents as ReturnType<typeof vi.fn>;
const del = api.deleteCallEvent as ReturnType<typeof vi.fn>;

const rows: LibraryEvent[] = [
  { id: "1", event_key: "interested", label: "Interested", description: "shows interest", outcome: "Hot",
    applies_to: "both", agent_count: 2, agents: [{ id: "a", name: "Sara" }, { id: "b", name: "Omar" }] },
  { id: "2", event_key: "dnc", label: "Do Not Call", description: null, outcome: "DNC",
    applies_to: "outbound", agent_count: 1, agents: [{ id: "a", name: "Sara" }] },
  { id: "3", event_key: "wrong", label: "Wrong Number", description: null, outcome: null,
    applies_to: "inbound", agent_count: 0, agents: [] },
];

beforeEach(() => {
  vi.clearAllMocks();
  get.mockResolvedValue({ data: rows, error: null });
});

describe("Call Events page", () => {
  it("lists events with outcome, scope and usage", async () => {
    render(<CallEvents />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(await screen.findByText("Interested")).toBeInTheDocument();
    for (const c of ["Event", "Outcome", "Applies to", "Used by", "Actions"]) {
      expect(screen.getByRole("columnheader", { name: c })).toBeInTheDocument();
    }
    expect(screen.getByText("Hot")).toBeInTheDocument();
    expect(screen.getByText("Inbound & outbound")).toBeInTheDocument();
    expect(screen.getByText("Outbound only")).toBeInTheDocument();
    expect(screen.getAllByText("Sara").length).toBeGreaterThan(0);
    expect(screen.getByText("Omar")).toBeInTheDocument();
    expect(screen.getByText("Not used")).toBeInTheDocument();
  });

  it("shows the names of the agents that use an event", async () => {
    render(<CallEvents />);
    expect(await screen.findByText("Omar")).toBeInTheDocument();
    expect(screen.getAllByText("Sara")).toHaveLength(2);
  });

  it("empty state offers to create the first event", async () => {
    get.mockResolvedValue({ data: [], error: null });
    render(<CallEvents />);
    expect(await screen.findByText("No events yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create your first event/ }));
    expect(await screen.findByText("New call event")).toBeInTheDocument();
  });

  it("error state shows the message and retries", async () => {
    get.mockResolvedValueOnce({ data: null, error: "Network error" });
    render(<CallEvents />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Interested")).toBeInTheDocument();
  });

  it("New Event opens an empty dialog", async () => {
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: /New Event/ }));
    expect(await screen.findByText("New call event")).toBeInTheDocument();
    expect(screen.getByLabelText("Event name")).toHaveValue("");
  });

  it("Edit opens the dialog prefilled with that event", async () => {
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: "Edit Do Not Call" }));
    expect(await screen.findByText("Edit event")).toBeInTheDocument();
    expect(screen.getByLabelText("Event name")).toHaveValue("Do Not Call");
    expect(screen.getByLabelText("Outcome value")).toHaveValue("DNC");
  });

  it("after saving, the list reloads", async () => {
    (api.createCallEvent as ReturnType<typeof vi.fn>).mockResolvedValue({ data: rows[0], error: null });
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: /New Event/ }));
    fireEvent.change(await screen.findByLabelText("Event name"), { target: { value: "Brand New" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it("delete: confirmation names the agents it will be removed from and keeps history", async () => {
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: "Delete Interested" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/removed from 2 agents \(Sara, Omar\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Past calls keep their recorded events/)).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
  });

  it("delete: an unused event says no agents use it", async () => {
    render(<CallEvents />);
    await screen.findByText("Wrong Number");
    fireEvent.click(screen.getByRole("button", { name: "Delete Wrong Number" }));
    expect(await screen.findByText(/No agents use it/)).toBeInTheDocument();
  });

  it("delete: cancel makes no API call", async () => {
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: "Delete Interested" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();
  });

  it("delete: confirm calls the API, reloads and toasts", async () => {
    del.mockResolvedValue({ data: { removed_from_agents: 2 }, error: null, warnings: [] });
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: "Delete Interested" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("1"));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Event deleted"));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("delete: a sync warning is shown as a warning, not as plain success", async () => {
    del.mockResolvedValue({ data: {}, error: null, warnings: ["Sara"] });
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: "Delete Interested" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("delete: an API error is toasted and the list is not reloaded", async () => {
    del.mockResolvedValue({ data: null, error: "Event not found." });
    render(<CallEvents />);
    await screen.findByText("Interested");
    fireEvent.click(screen.getByRole("button", { name: "Delete Interested" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Event not found."));
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Interested")).toBeInTheDocument();
  });

  it("renders hostile event text as plain text", async () => {
    get.mockResolvedValue({ data: [{ ...rows[2], label: "<img src=x onerror=alert(1)>" }], error: null });
    const { container } = render(<CallEvents />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
  });
});
