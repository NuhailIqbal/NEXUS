import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { updateCallback: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { RescheduleDialog } from "./RescheduleDialog";
import type { Callback } from "./callbackTypes";

const future = new Date(Date.now() + 3 * 86400_000).toISOString();
const cb = (over: Partial<Callback> = {}): Callback => ({
  id: "cb1", agent_id: "a", agent_name: "Sara", contact_name: "Ali Khan", phone: "+15551230001", due_at: future,
  timezone: "Asia/Karachi", time_source: "caller", requested_text: null, status: "pending", attempts: 0,
  last_error: null, placed_call_id: null, created_at: "2026-10-05T00:00:00Z", ...over,
});
const update = api.updateCallback as ReturnType<typeof vi.fn>;
const input = () => screen.getByLabelText("Call back at") as HTMLInputElement;

function setup(callback: Callback | null = cb()) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(<RescheduleDialog callback={callback} onOpenChange={onOpenChange} onSaved={onSaved} />);
  return { onSaved, onOpenChange };
}

beforeEach(() => vi.clearAllMocks());

describe("RescheduleDialog", () => {
  it("renders nothing without a callback", () => {
    setup(null);
    expect(screen.queryByText("Reschedule callback")).not.toBeInTheDocument();
  });

  it("names the customer and the timezone the time is read in", () => {
    setup();
    expect(screen.getByText(/Ali Khan — time is in Asia\/Karachi/)).toBeInTheDocument();
  });

  it("starts from the current callback time, shown in that timezone", () => {
    setup(cb({ due_at: "2030-06-06T12:00:00Z" }));
    expect(input().value).toBe("2030-06-06T17:00");
  });

  it("an overdue callback starts from about an hour from now instead of the past", () => {
    setup(cb({ due_at: "2020-01-01T00:00:00Z" }));
    expect(new Date(input().value).getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear());
  });

  it("falls back to the phone number when the customer has no name", () => {
    setup(cb({ contact_name: null }));
    expect(screen.getByText(/\+15551230001 — time is in/)).toBeInTheDocument();
  });

  it("saves the chosen wall-clock time exactly as typed", async () => {
    update.mockResolvedValue({ data: {}, error: null });
    const { onSaved, onOpenChange } = setup();
    fireEvent.change(input(), { target: { value: "2030-07-01T14:30" } });
    fireEvent.click(screen.getByRole("button", { name: /^Reschedule$/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith("cb1", { due_local: "2030-07-01T14:30" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Callback rescheduled");
  });

  it("an empty box is refused locally", () => {
    setup();
    fireEvent.change(input(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: /^Reschedule$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a date and time.");
    expect(update).not.toHaveBeenCalled();
  });

  it("a server refusal (e.g. a time in the past) shows inline and keeps the dialog open", async () => {
    update.mockResolvedValue({ data: null, error: "Pick a time in the future." });
    const { onSaved, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: /^Reschedule$/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick a time in the future.");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    fireEvent.change(input(), { target: { value: "2030-07-01T14:30" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks double submit while saving", async () => {
    let done: (v: unknown) => void = () => {};
    update.mockReturnValue(new Promise((r) => { done = r; }));
    setup();
    fireEvent.click(screen.getByRole("button", { name: /^Reschedule$/ }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    done({ data: {}, error: null });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it("Cancel closes without saving", () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(update).not.toHaveBeenCalled();
  });
});
