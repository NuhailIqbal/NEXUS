import { choose } from "@/test/pick";
import "@/test/radix-stubs";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { RetryFields } from "./RetryFields";
import { defaultRetry, type RetrySettings } from "@/lib/callRetry";

/** Renders the form with real state and reports every value it emits. */
function Harness({ initial, onValue, editing }: { initial: RetrySettings; onValue: (v: RetrySettings) => void; editing?: boolean }) {
  const [v, setV] = useState(initial);
  return <RetryFields idPrefix="t" value={v} editing={editing} onChange={(n) => { setV(n); onValue(n); }} />;
}
const toggle = () => screen.getByRole("switch", { name: "Enable auto redial" });

describe("RetryFields", () => {
  it("is off by default and shows nothing else", () => {
    render(<Harness initial={defaultRetry()} onValue={vi.fn()} />);
    expect(toggle()).not.toBeChecked();
    expect(screen.queryByText("Calls per number")).not.toBeInTheDocument();
    expect(screen.queryByText("Retry on")).not.toBeInTheDocument();
    expect(screen.getByText(/every number in the list is called once/)).toBeInTheDocument();
  });

  it("switching on shows the three settings with their defaults", () => {
    const seen = vi.fn();
    render(<Harness initial={defaultRetry()} onValue={seen} />);
    fireEvent.click(toggle());
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.getByLabelText("Calls per number")).toHaveTextContent("3 calls");
    expect(screen.getByLabelText("Wait between calls")).toHaveTextContent("10 minutes");
    for (const label of ["No Answer", "Busy", "Voicemail / Answering Machine", "Call Failed / Network Error"]) {
      expect(screen.getByRole("checkbox", { name: label })).toBeChecked();
    }
  });

  it("the user selects the attempts and the interval", async () => {
    const seen = vi.fn();
    render(<Harness initial={{ ...defaultRetry(), enabled: true }} onValue={seen} />);
    await choose("Calls per number", "7 calls");
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ maxAttempts: 7 }));
    await choose("Wait between calls", "45 minutes");
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ maxAttempts: 7, intervalMinutes: 45 }));
  });

  it("offers exactly 1 to 10 calls and 5 to 60 minutes", () => {
    render(<Harness initial={{ ...defaultRetry(), enabled: true }} onValue={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Calls per number"));
    const calls = screen.getAllByRole("option").map((o) => o.textContent);
    expect(calls).toEqual(["1 call", ...Array.from({ length: 9 }, (_, i) => `${i + 2} calls`)]);
  });

  it("each outcome can be ticked and unticked on its own", () => {
    const seen = vi.fn();
    render(<Harness initial={{ ...defaultRetry(), enabled: true }} onValue={seen} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Busy" }));
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ retryOn: ["no_answer", "voicemail", "failed"] }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Voicemail / Answering Machine" }));
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ retryOn: ["no_answer", "failed"] }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Busy" }));
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ retryOn: ["no_answer", "busy", "failed"] }));
  });

  it("with nothing ticked it says so", () => {
    render(<Harness initial={{ ...defaultRetry(), enabled: true, retryOn: ["busy"] }} onValue={vi.fn()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Busy" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one outcome to redial on.");
  });

  it("lists what is never retried, and mentions the calling hours", () => {
    render(<Harness initial={{ ...defaultRetry(), enabled: true }} onValue={vi.fn()} />);
    expect(screen.getByText(/never retried once someone answered/)).toBeInTheDocument();
    expect(screen.getByText(/transferred/)).toBeInTheDocument();
    expect(screen.getByText(/calling hours/)).toBeInTheDocument();
  });

  it("when editing, says that changes apply to calls placed from now on", () => {
    const { rerender } = render(<Harness initial={{ ...defaultRetry(), enabled: true }} onValue={vi.fn()} />);
    expect(screen.queryByText(/not to calls already in progress/)).not.toBeInTheDocument();
    rerender(<Harness initial={{ ...defaultRetry(), enabled: true }} onValue={vi.fn()} editing />);
    expect(screen.getByText(/not to calls already in progress/)).toBeInTheDocument();
  });
});
