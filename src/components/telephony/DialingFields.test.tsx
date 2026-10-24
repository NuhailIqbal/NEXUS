import "@/test/radix-stubs";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { DialingFields } from "./DialingFields";
import { defaultDialing, type DialingLimits, type DialingSettings } from "@/lib/dialingStrategy";

/** Renders the form with real state and reports every value it emits. */
function Harness({ initial, onValue, editing, limits }: {
  initial: DialingSettings; onValue: (v: DialingSettings) => void; editing?: boolean; limits?: DialingLimits | null;
}) {
  const [v, setV] = useState(initial);
  return <DialingFields idPrefix="t" value={v} editing={editing} limits={limits} onChange={(n) => { setV(n); onValue(n); }} />;
}
const radio = (name: string) => screen.getByRole("radio", { name });

describe("DialingFields", () => {
  it("offers the three strategies in a radio group, Sequential chosen by default", () => {
    render(<Harness initial={defaultDialing()} onValue={vi.fn()} />);
    expect(screen.getByRole("radiogroup", { name: "Dialing strategy" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"))).toEqual(["Sequential", "Concurrent", "Paced"]);
    expect(radio("Sequential")).toBeChecked();
    expect(radio("Concurrent")).not.toBeChecked();
    expect(radio("Paced")).not.toBeChecked();
    expect(screen.getByText(/One call at a time/)).toBeInTheDocument();
  });

  it("Sequential shows only the delay field", () => {
    render(<Harness initial={defaultDialing()} onValue={vi.fn()} />);
    expect(screen.queryByLabelText("Concurrent Calls")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Calls per Minute")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Delay between calls (seconds)")).toHaveValue(0);
    expect(screen.getByText(/after a call ends before the next call starts/)).toBeInTheDocument();
  });

  it("picking Concurrent shows Concurrent Calls (default 5) and the delay", () => {
    const seen = vi.fn();
    render(<Harness initial={defaultDialing()} onValue={seen} />);
    fireEvent.click(radio("Concurrent"));
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ strategy: "concurrent" }));
    expect(radio("Concurrent")).toBeChecked();
    const n = screen.getByLabelText("Concurrent Calls");
    expect(n).toHaveValue(5);
    expect(n).toHaveAttribute("type", "number");
    expect(n).toHaveAttribute("min", "1");
    expect(n).toHaveAttribute("max", "20");
    expect(screen.queryByLabelText("Calls per Minute")).not.toBeInTheDocument();
    expect(screen.getByText(/between starting one call and the next/)).toBeInTheDocument();
  });

  it("picking Paced shows Calls per Minute (default 10) and the delay", () => {
    render(<Harness initial={defaultDialing()} onValue={vi.fn()} />);
    fireEvent.click(radio("Paced"));
    const n = screen.getByLabelText("Calls per Minute");
    expect(n).toHaveValue(10);
    expect(n).toHaveAttribute("min", "1");
    expect(n).toHaveAttribute("max", "60");
    expect(screen.queryByLabelText("Concurrent Calls")).not.toBeInTheDocument();
    expect(screen.getByText(/Least time between two calls/)).toBeInTheDocument();
  });

  it("the user types the numbers", () => {
    const seen = vi.fn();
    render(<Harness initial={{ ...defaultDialing(), strategy: "concurrent" }} onValue={seen} />);
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "12" } });
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ concurrentCalls: 12 }));
    fireEvent.change(screen.getByLabelText("Delay between calls (seconds)"), { target: { value: "3" } });
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ concurrentCalls: 12, delaySeconds: 3 }));
  });

  it("keeps the other strategy's numbers when switching", () => {
    render(<Harness initial={{ ...defaultDialing(), strategy: "concurrent", concurrentCalls: 9 }} onValue={vi.fn()} />);
    fireEvent.click(radio("Paced"));
    fireEvent.click(radio("Concurrent"));
    expect(screen.getByLabelText("Concurrent Calls")).toHaveValue(9);
  });

  it("says so when a number is out of range or empty", () => {
    render(<Harness initial={{ ...defaultDialing(), strategy: "concurrent" }} onValue={vi.fn()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "21" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Concurrent calls must be a whole number from 1 to 20.");
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Concurrent calls must be a whole number from 1 to 20.");
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Delay between calls (seconds)"), { target: { value: "61" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Delay between calls must be a whole number of seconds from 0 to 60.");
  });

  it("the delay label does not collide with the redial step's 'Wait between calls'", () => {
    render(<Harness initial={defaultDialing()} onValue={vi.fn()} />);
    expect(screen.queryByLabelText("Wait between calls")).not.toBeInTheDocument();
  });

  it("shows the amber account-limit line only when the settings exceed the limit", () => {
    const initial = { ...defaultDialing(), strategy: "concurrent" as const, concurrentCalls: 5 };
    const { rerender } = render(<Harness initial={initial} onValue={vi.fn()} limits={{ account_limit: null }} />);
    expect(screen.queryByText(/your account allows/)).not.toBeInTheDocument();
    rerender(<Harness initial={initial} onValue={vi.fn()} limits={{ account_limit: 3, source: "account" }} />);
    expect(screen.getByText(/but your account allows 3 calls at the same time/)).toBeInTheDocument();
    rerender(<Harness initial={initial} onValue={vi.fn()} limits={{ account_limit: 5 }} />);
    expect(screen.queryByText(/your account allows/)).not.toBeInTheDocument();
  });

  it("the account-limit line follows the strategy", () => {
    render(<Harness initial={{ ...defaultDialing(), strategy: "concurrent", concurrentCalls: 5 }} onValue={vi.fn()} limits={{ account_limit: 3 }} />);
    expect(screen.getByText(/Calls will run 3 at a time/)).toBeInTheDocument();
    fireEvent.click(radio("Paced"));
    expect(screen.queryByText(/Calls will run 3 at a time/)).not.toBeInTheDocument();
    expect(screen.getByText(/may place fewer than 10 calls per minute/)).toBeInTheDocument();
    fireEvent.click(radio("Sequential"));
    expect(screen.queryByText(/your account allows/i)).not.toBeInTheDocument();
  });

  it("when editing, says that changes apply to calls placed from now on", () => {
    const { rerender } = render(<Harness initial={defaultDialing()} onValue={vi.fn()} />);
    expect(screen.queryByText(/not to calls already in progress/)).not.toBeInTheDocument();
    rerender(<Harness initial={defaultDialing()} onValue={vi.fn()} editing />);
    expect(screen.getByText(/not to calls already in progress/)).toBeInTheDocument();
  });

  it("never names the carrier", () => {
    const { container } = render(<Harness initial={defaultDialing()} onValue={vi.fn()} editing limits={{ account_limit: 1 }} />);
    expect(container.textContent).not.toMatch(/vapi|twilio|vonage|telnyx/i);
  });
});
