import "@/test/radix-stubs";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getCallEvents: vi.fn(), createCallEvent: vi.fn(), updateCallEvent: vi.fn(), deleteCallEvent: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { api } from "@/services/api";
import { StepCallEvents } from "./StepCallEvents";
import { MAX_CALL_EVENTS, syncWarningText, toCallEventsPayload, type LibraryEvent } from "./callEventTypes";

const ev = (id: string, label: string, extra: Partial<LibraryEvent> = {}): LibraryEvent => ({
  id, event_key: label.toLowerCase().replace(/\W+/g, "_"), label, description: null, outcome: label, applies_to: "both", ...extra,
});
const mockLibrary = (list: LibraryEvent[]) =>
  (api.getCallEvents as ReturnType<typeof vi.fn>).mockResolvedValue({ data: list, error: null });

function Harness({ initial = [], compact }: { initial?: string[]; compact?: boolean }) {
  const [ids, setIds] = useState<string[]>(initial);
  return (
    <>
      <StepCallEvents selectedIds={ids} onChange={setIds} compact={compact} />
      <pre data-testid="ids">{JSON.stringify(ids)}</pre>
    </>
  );
}
const ids = (): string[] => JSON.parse(screen.getByTestId("ids").textContent || "[]");

beforeEach(() => vi.clearAllMocks());

describe("StepCallEvents (library picker)", () => {
  it("shows a loading state, then the library events with scope and outcome", async () => {
    mockLibrary([
      ev("1", "Callback Requested", { description: "asks later", outcome: "Callback", applies_to: "inbound" }),
      ev("2", "Do Not Call", { applies_to: "outbound" }),
    ]);
    render(<Harness />);
    expect(screen.getByText(/Loading your events/)).toBeInTheDocument();
    expect(await screen.findByText("Callback Requested")).toBeInTheDocument();
    expect(screen.getByText("Inbound only")).toBeInTheDocument();
    expect(screen.getByText("Outbound only")).toBeInTheDocument();
    expect(screen.getByText("→ Callback")).toBeInTheDocument();
    expect(screen.getByText("asks later")).toBeInTheDocument();
  });

  it("ticking and unticking updates the selected ids", async () => {
    mockLibrary([ev("1", "A"), ev("2", "B")]);
    render(<Harness />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "A" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "B" }));
    expect(ids()).toEqual(["1", "2"]);
    expect(screen.getByText(/2 selected/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "A" }));
    expect(ids()).toEqual(["2"]);
  });

  it("two clicks in the same instant both count (no lost update)", async () => {
    mockLibrary([ev("1", "A"), ev("2", "B"), ev("3", "C")]);
    render(<Harness initial={["1"]} />);
    const a = await screen.findByRole("checkbox", { name: "A" });
    const b = screen.getByRole("checkbox", { name: "B" });
    const c = screen.getByRole("checkbox", { name: "C" });
    act(() => { a.click(); b.click(); c.click(); });   // untick A, tick B and C before any re-render
    expect(ids()).toEqual(["2", "3"]);
  });

  it("starts with the agent's existing selection ticked", async () => {
    mockLibrary([ev("1", "A"), ev("2", "B")]);
    render(<Harness initial={["2"]} />);
    expect(await screen.findByRole("checkbox", { name: "B" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "A" })).not.toBeChecked();
  });

  it("stops at the cap: unticked events are disabled", async () => {
    const list = Array.from({ length: MAX_CALL_EVENTS + 2 }, (_, i) => ev(`id${i}`, `E${i}`));
    mockLibrary(list);
    render(<Harness initial={list.slice(0, MAX_CALL_EVENTS).map((e) => e.id)} />);
    expect(await screen.findByRole("checkbox", { name: `E${MAX_CALL_EVENTS}` })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "E0" })).toBeEnabled();
  });

  it("empty library shows a create call-to-action that opens the dialog", async () => {
    mockLibrary([]);
    render(<Harness />);
    expect(await screen.findByText("You haven't created any events yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Create your first event/ }));
    expect(await screen.findByText("New call event")).toBeInTheDocument();
  });

  it("shows an error with a working retry", async () => {
    (api.getCallEvents as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: null, error: "boom" })
      .mockResolvedValueOnce({ data: [ev("1", "A")], error: null });
    render(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("checkbox", { name: "A" })).toBeInTheDocument();
    expect(api.getCallEvents).toHaveBeenCalledTimes(2);
  });

  it("drops selected ids whose event no longer exists", async () => {
    mockLibrary([ev("1", "A")]);
    render(<Harness initial={["1", "ghost"]} />);
    await screen.findByRole("checkbox", { name: "A" });
    await waitFor(() => expect(ids()).toEqual(["1"]));
  });

  it("a newly created event is added to the list and selected", async () => {
    mockLibrary([ev("1", "A")]);
    (api.createCallEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: ev("9", "Fresh", { outcome: "Fresh" }), error: null,
    });
    render(<Harness initial={["1"]} />);
    await screen.findByRole("checkbox", { name: "A" });
    fireEvent.click(screen.getByRole("button", { name: /New event/ }));
    fireEvent.change(await screen.findByLabelText("Event name"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(await screen.findByRole("checkbox", { name: "Fresh" })).toBeChecked();
    expect(ids()).toEqual(["1", "9"]);
  });

  it("compact mode hides the hero header; header shows otherwise", async () => {
    mockLibrary([ev("1", "A")]);
    const { unmount } = render(<Harness compact />);
    await screen.findByRole("checkbox", { name: "A" });
    expect(screen.queryByText("Moments your agent should report during a call")).not.toBeInTheDocument();
    unmount();
    render(<Harness />);
    expect(await screen.findByText("Moments your agent should report during a call")).toBeInTheDocument();
  });

  it("renders hostile event text as plain text", async () => {
    mockLibrary([ev("1", "<img src=x onerror=alert(1)>", { description: "<script>1</script>" })]);
    const { container } = render(<Harness />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("links to the Manage events page in a new tab", async () => {
    mockLibrary([]);
    render(<Harness />);
    const link = await screen.findByRole("link", { name: "Manage events" });
    expect(link).toHaveAttribute("href", "/dashboard/call-events");
    expect(link).toHaveAttribute("target", "_blank");
  });
});

describe("helpers", () => {
  it("toCallEventsPayload maps ids to {event_id}", () => {
    expect(toCallEventsPayload(["a", "b"])).toEqual([{ event_id: "a" }, { event_id: "b" }]);
    expect(toCallEventsPayload([])).toEqual([]);
  });
  it("syncWarningText is singular/plural, lists names and never says VAPI", () => {
    expect(syncWarningText(["Sara"])).toMatch(/this agent .*Sara/);
    expect(syncWarningText(["Sara", "Omar"])).toMatch(/these agents .*Sara, Omar/);
    expect(syncWarningText(["Sara"])).not.toMatch(/vapi/i);
  });
});
