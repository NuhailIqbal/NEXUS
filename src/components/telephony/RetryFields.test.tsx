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

  describe("follow-up rounds", () => {
    const on = { ...defaultRetry(), enabled: true };

    it("are off by default and the controls are disabled, with a hint, while Auto Redial is off", () => {
      render(<Harness initial={defaultRetry()} onValue={vi.fn()} />);
      expect(screen.getByText("Follow-up rounds")).toBeInTheDocument();
      expect(screen.getByLabelText("Rounds")).toBeDisabled();
      expect(screen.getByLabelText("Rounds")).toHaveTextContent("Off");
      expect(screen.getByLabelText("Wait between rounds")).toBeDisabled();
      expect(screen.getByRole("button", { name: "4 h" })).toBeDisabled();
      expect(screen.getByText(/Turn on Auto Redial above/)).toBeInTheDocument();
    });

    it("switching Auto Redial on enables the rounds, which are still off", () => {
      render(<Harness initial={defaultRetry()} onValue={vi.fn()} />);
      fireEvent.click(toggle());
      expect(screen.getByLabelText("Rounds")).toBeEnabled();
      expect(screen.getByLabelText("Rounds")).toHaveTextContent("Off");
      expect(screen.getByLabelText("Wait between rounds")).toBeDisabled();
      expect(screen.getByText(/Off: numbers that never picked up are left as they are/)).toBeInTheDocument();
    });

    it("offers Off, 1, 2 and 3 rounds", () => {
      render(<Harness initial={on} onValue={vi.fn()} />);
      fireEvent.click(screen.getByLabelText("Rounds"));
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Off", "1 round", "2 rounds", "3 rounds"]);
    });

    it("choosing rounds shows the explanation with the number, and enables the wait", async () => {
      const seen = vi.fn();
      render(<Harness initial={on} onValue={seen} />);
      await choose("Rounds", "2 rounds");
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ followupRounds: 2, followupGapHours: 24 }));
      expect(screen.getByText(/called again, up to 2 more times\. Numbers that answered, were transferred, disqualified, asked not to be called or are invalid are never called again\. Calling hours always apply\./))
        .toBeInTheDocument();
      expect(screen.getByLabelText("Wait between rounds")).toBeEnabled();
      await choose("Rounds", "1 round");
      expect(screen.getByText(/up to 1 more time\./)).toBeInTheDocument();
    });

    it("the wait is a number of hours, with presets of 4, 12, 24 (next day) and 48", () => {
      const seen = vi.fn();
      render(<Harness initial={{ ...on, followupRounds: 2 }} onValue={seen} />);
      expect(screen.getByLabelText("Wait between rounds")).toHaveValue(24);
      expect(screen.getByRole("button", { name: "24 h (next day)" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "4 h" }));
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ followupGapHours: 4 }));
      expect(screen.getByLabelText("Wait between rounds")).toHaveValue(4);
      expect(screen.getByRole("button", { name: "4 h" })).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(screen.getByRole("button", { name: "12 h" }));
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ followupGapHours: 12 }));
      fireEvent.click(screen.getByRole("button", { name: "48 h" }));
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ followupGapHours: 48 }));
      fireEvent.change(screen.getByLabelText("Wait between rounds"), { target: { value: "30" } });
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ followupGapHours: 30 }));
      for (const p of ["4 h", "12 h", "24 h (next day)", "48 h"]) expect(screen.getByRole("button", { name: p })).toHaveAttribute("aria-pressed", "false");
    });

    it("a wait outside 1 to 48 hours, or an empty box, says so", () => {
      render(<Harness initial={{ ...on, followupRounds: 1 }} onValue={vi.fn()} />);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText("Wait between rounds"), { target: { value: "49" } });
      expect(screen.getByRole("alert")).toHaveTextContent("Wait between rounds must be a whole number of hours from 1 to 48.");
      fireEvent.change(screen.getByLabelText("Wait between rounds"), { target: { value: "" } });
      expect(screen.getByRole("alert")).toHaveTextContent("from 1 to 48");
      fireEvent.change(screen.getByLabelText("Wait between rounds"), { target: { value: "1" } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("turning Auto Redial off turns the rounds off too, so the server never gets rounds without it", () => {
      const seen = vi.fn();
      render(<Harness initial={{ ...on, followupRounds: 3, followupGapHours: 12 }} onValue={seen} />);
      fireEvent.click(toggle());
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false, followupRounds: 0, followupGapHours: 12 }));
      expect(screen.getByLabelText("Rounds")).toBeDisabled();
    });

    it("never names the carrier", () => {
      const { container } = render(<Harness initial={{ ...on, followupRounds: 2 }} onValue={vi.fn()} />);
      expect(container.textContent?.toLowerCase()).not.toContain("vapi");
    });
  });
});
