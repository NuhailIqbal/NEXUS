import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import {
  StepCallEvents, toCallEventsPayload, MAX_CALL_EVENTS, type CallEventForm,
} from "./StepCallEvents";

function Harness({ initial = [], compact }: { initial?: CallEventForm[]; compact?: boolean }) {
  const [events, setEvents] = useState<CallEventForm[]>(initial);
  return (
    <>
      <StepCallEvents events={events} onChange={setEvents} compact={compact} />
      <pre data-testid="state">{JSON.stringify(events)}</pre>
    </>
  );
}
const state = (): CallEventForm[] => JSON.parse(screen.getByTestId("state").textContent || "[]");
const ev = (label: string): CallEventForm => ({ label, description: "", outcome: "" });

describe("StepCallEvents", () => {
  it("renders the empty state with all six starter templates and no rows", () => {
    render(<Harness />);
    expect(screen.getByText("Call Events")).toBeInTheDocument();
    for (const t of ["Interested", "Callback Requested", "Not Interested", "Do Not Call", "Wrong Number", "Appointment Booked"]) {
      expect(screen.getByRole("button", { name: `+ ${t}` })).toBeEnabled();
    }
    expect(state()).toEqual([]);
    expect(screen.queryByPlaceholderText("Callback Requested")).not.toBeInTheDocument();
  });

  it("compact mode hides the hero header", () => {
    render(<Harness compact />);
    expect(screen.queryByText("Moments your agent should report during a call")).not.toBeInTheDocument();
  });

  it("adds a template with its description and outcome, then disables that template", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "+ Callback Requested" }));
    expect(state()).toEqual([
      { label: "Callback Requested", description: "The caller asks to be called back later", outcome: "Callback" },
    ]);
    expect(screen.getByRole("button", { name: "+ Callback Requested" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Do Not Call" })).toBeEnabled();
  });

  it("template disable check is case/space-insensitive against custom names", () => {
    render(<Harness initial={[ev("  do not call ")]} />);
    expect(screen.getByRole("button", { name: "+ Do Not Call" })).toBeDisabled();
  });

  it("adds a blank custom event and edits every field", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: /Add custom event/ }));
    fireEvent.change(screen.getByPlaceholderText("Callback Requested"), { target: { value: "VIP Lead" } });
    fireEvent.change(screen.getByPlaceholderText("Callback"), { target: { value: "Hot" } });
    fireEvent.change(screen.getByPlaceholderText("The caller asks to be called back later"), { target: { value: "Says budget approved" } });
    expect(state()).toEqual([{ label: "VIP Lead", outcome: "Hot", description: "Says budget approved" }]);
  });

  it("removes only the chosen row", () => {
    render(<Harness initial={[ev("A"), ev("B"), ev("C")]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove event" })[1]);
    expect(state().map((e) => e.label)).toEqual(["A", "C"]);
  });

  it("editing one row leaves the others untouched", () => {
    render(<Harness initial={[ev("A"), ev("B")]} />);
    fireEvent.change(screen.getAllByPlaceholderText("Callback Requested")[1], { target: { value: "B2" } });
    expect(state().map((e) => e.label)).toEqual(["A", "B2"]);
  });

  it("stops at the 20-event cap (templates and custom button disabled)", () => {
    render(<Harness initial={Array.from({ length: MAX_CALL_EVENTS }, (_, i) => ev(`E${i}`))} />);
    expect(screen.getByRole("button", { name: /Add custom event/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Interested" })).toBeDisabled();
  });

  it("inputs enforce the same length limits as the backend", () => {
    render(<Harness initial={[ev("A")]} />);
    expect(screen.getByPlaceholderText("Callback Requested")).toHaveAttribute("maxLength", "60");
    expect(screen.getByPlaceholderText("Callback")).toHaveAttribute("maxLength", "60");
    expect(screen.getByPlaceholderText("The caller asks to be called back later")).toHaveAttribute("maxLength", "200");
  });

  it("renders hostile text as plain text, never as markup", () => {
    const { container } = render(<Harness initial={[{ label: "<img src=x onerror=alert(1)>", description: "<script>1</script>", outcome: "x" }]} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect((screen.getByPlaceholderText("Callback Requested") as HTMLInputElement).value).toBe("<img src=x onerror=alert(1)>");
  });

  it("all rows have accessible labels for their three fields", () => {
    render(<Harness initial={[ev("A")]} />);
    const row = screen.getByPlaceholderText("Callback Requested").closest("div.rounded-xl") as HTMLElement;
    expect(within(row).getByText("Event name")).toBeInTheDocument();
    expect(within(row).getByText("Outcome value")).toBeInTheDocument();
    expect(within(row).getByText("When should the agent raise it?")).toBeInTheDocument();
  });
});

describe("toCallEventsPayload", () => {
  it("drops blank-label rows, trims, and nulls empty optional fields", () => {
    expect(
      toCallEventsPayload([
        { label: "  Interested ", description: "  ", outcome: "" },
        { label: "   ", description: "orphan", outcome: "x" },
        { label: "Do Not Call", description: " stop ", outcome: " DNC " },
      ]),
    ).toEqual([
      { label: "Interested", description: null, outcome: null },
      { label: "Do Not Call", description: "stop", outcome: "DNC" },
    ]);
  });
  it("returns an empty array for no events (so 'clear all' is sent as [])", () => {
    expect(toCallEventsPayload([])).toEqual([]);
  });
});
