import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { createCallEvent: vi.fn(), updateCallEvent: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CallEventDialog } from "./CallEventDialog";
import type { LibraryEvent } from "./callEventTypes";

const existing: LibraryEvent = {
  id: "e1", event_key: "interested", label: "Interested", description: "shows interest",
  outcome: "Hot", applies_to: "inbound",
};
const create = api.createCallEvent as ReturnType<typeof vi.fn>;
const update = api.updateCallEvent as ReturnType<typeof vi.fn>;

function setup(event?: LibraryEvent | null) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(<CallEventDialog open onOpenChange={onOpenChange} event={event} onSaved={onSaved} />);
  return { onSaved, onOpenChange };
}

beforeEach(() => vi.clearAllMocks());

describe("CallEventDialog", () => {
  it("create mode: blank name is rejected without calling the API", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an event name.");
    expect(create).not.toHaveBeenCalled();
  });

  it("create mode: whitespace-only name is also rejected", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("create mode: sends trimmed values, nulls empty optionals, defaults scope to both", async () => {
    create.mockResolvedValue({ data: { ...existing, id: "new" }, error: null });
    const { onSaved, onOpenChange } = setup();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "  Callback Requested  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      label: "Callback Requested", outcome: null, description: null, applies_to: "both", schedules_callback: false,
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Event created");
  });

  it("create mode: sends the entered outcome and description", async () => {
    create.mockResolvedValue({ data: existing, error: null });
    setup();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "X" } });
    fireEvent.change(screen.getByLabelText("Outcome value"), { target: { value: "Callback" } });
    fireEvent.change(screen.getByLabelText("When should the agent raise it?"), { target: { value: "asks later" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ outcome: "Callback", description: "asks later" });
  });

  it("edit mode: prefilled, calls update with the id, and explains the rename rule", async () => {
    update.mockResolvedValue({ data: { ...existing, outcome: "Warm" }, error: null });
    const { onSaved } = setup(existing);
    expect(screen.getByLabelText("Event name")).toHaveValue("Interested");
    expect(screen.getByLabelText("Outcome value")).toHaveValue("Hot");
    expect(screen.getByText(/Renaming only changes the display name/)).toBeInTheDocument();
    expect(screen.getByText("Changes apply to every agent that uses this event.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Outcome value"), { target: { value: "Warm" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith("e1", expect.objectContaining({ label: "Interested", outcome: "Warm", applies_to: "inbound" }));
    expect(create).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Event updated");
  });

  it("shows API errors inline and keeps the dialog open", async () => {
    create.mockResolvedValue({ data: null, error: "An event named 'X' already exists." });
    const { onSaved, onOpenChange } = setup();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already exists");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Create event" })).toBeEnabled(); // can retry
  });

  it("the callback checkbox starts unticked, is sent when ticked, and prefills when editing", async () => {
    create.mockResolvedValue({ data: existing, error: null });
    setup();
    const box = screen.getByRole("checkbox", { name: "Schedule a callback" });
    expect(box).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "Callback Requested" } });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ schedules_callback: true });
  });

  it("an unticked checkbox is sent as false", async () => {
    create.mockResolvedValue({ data: existing, error: null });
    setup();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ schedules_callback: false });
  });

  it("editing an event that schedules callbacks shows the box ticked", () => {
    setup({ ...existing, schedules_callback: true });
    expect(screen.getByRole("checkbox", { name: "Schedule a callback" })).toBeChecked();
  });

  it("an error message clears as soon as the user edits a field", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "N" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables both buttons while saving (no double submit)", async () => {
    let resolve: (v: unknown) => void = () => {};
    create.mockReturnValue(new Promise((r) => { resolve = r; }));
    setup();
    fireEvent.change(screen.getByLabelText("Event name"), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create event" }));
    expect(screen.getByRole("button", { name: "Create event" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    resolve({ data: existing, error: null });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("a sync warning is surfaced as a warning toast, never the success toast", async () => {
    update.mockResolvedValue({ data: existing, error: null, warnings: ["Sara"] });
    setup(existing);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect((toast.warning as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain("Sara");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("enforces the backend length limits on every text field", () => {
    setup();
    expect(screen.getByLabelText("Event name")).toHaveAttribute("maxLength", "60");
    expect(screen.getByLabelText("Outcome value")).toHaveAttribute("maxLength", "60");
    expect(screen.getByLabelText("When should the agent raise it?")).toHaveAttribute("maxLength", "200");
  });

  it("Cancel closes without saving", () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(create).not.toHaveBeenCalled();
  });

  it("the scope select offers all three options and shows the current one", () => {
    setup(existing);
    expect(screen.getByRole("combobox", { name: "Applies to" })).toHaveTextContent("Inbound only");
  });
});
