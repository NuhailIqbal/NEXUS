import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { updateCalendarSettings: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CalendarSettingsDialog } from "./CalendarSettingsDialog";
import type { CalendarSettings } from "./calendarTypes";

const settings: CalendarSettings = {
  timezone: "Asia/Karachi", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "17:00",
  slot_minutes: 30, buffer_minutes: 0, min_notice_hours: 2, max_days_ahead: 30,
};
const update = api.updateCalendarSettings as ReturnType<typeof vi.fn>;

function setup() {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(<CalendarSettingsDialog open onOpenChange={onOpenChange} settings={settings} onSaved={onSaved} />);
  return { onSaved, onOpenChange };
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

beforeEach(() => vi.clearAllMocks());

describe("CalendarSettingsDialog", () => {
  it("shows the current settings", () => {
    setup();
    expect(screen.getByLabelText("Timezone")).toHaveValue("Asia/Karachi");
    expect(screen.getByLabelText("Day starts")).toHaveValue("09:00");
    expect(screen.getByLabelText("Day ends")).toHaveValue("17:00");
    expect(screen.getByLabelText(/Meeting length/)).toHaveValue(30);
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) expect(screen.getByRole("button", { name: d })).toHaveAttribute("aria-pressed", "true");
    for (const d of ["Sat", "Sun"]) expect(screen.getByRole("button", { name: d })).toHaveAttribute("aria-pressed", "false");
  });

  it("saves the edited values and reports them back", async () => {
    update.mockResolvedValue({ data: { ...settings, slot_minutes: 45, work_days: [0, 1, 2, 3, 4, 5] }, error: null });
    const { onSaved, onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    fireEvent.change(screen.getByLabelText(/Meeting length/), { target: { value: "45" } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ slot_minutes: 45, work_days: [0, 1, 2, 3, 4, 5] }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Calendar settings saved");
  });

  it("toggling a day off removes it, and keeps the days sorted when one is re-added", async () => {
    update.mockResolvedValue({ data: settings, error: null });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Wed" }));
    fireEvent.click(screen.getByRole("button", { name: "Wed" }));
    save();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].work_days).toEqual([0, 1, 2, 3, 4]);
  });

  it("an account on UTC (not in the browser's own list) can still save", async () => {
    update.mockResolvedValue({ data: { ...settings, timezone: "UTC" }, error: null });
    const onSaved = vi.fn();
    render(<CalendarSettingsDialog open onOpenChange={vi.fn()} settings={{ ...settings, timezone: "UTC" }} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText(/Buffer/), { target: { value: "10" } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update.mock.calls[0][0].timezone).toBe("UTC");
  });

  it("refuses an unknown timezone without calling the API", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "Mars/Olympus" } });
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/timezone/i);
    expect(update).not.toHaveBeenCalled();
  });

  it("refuses no working days, a backwards day, and bad numbers", () => {
    setup();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/working day/);
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    fireEvent.change(screen.getByLabelText("Day ends"), { target: { value: "08:00" } });
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/after start/);
    fireEvent.change(screen.getByLabelText("Day ends"), { target: { value: "17:00" } });
    fireEvent.change(screen.getByLabelText(/Meeting length/), { target: { value: "" } });
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/Meeting length/);
    expect(update).not.toHaveBeenCalled();
  });

  it("shows a server error inline, keeps the dialog open, and clears it on the next edit", async () => {
    update.mockResolvedValue({ data: null, error: "That timezone isn't recognised." });
    const { onOpenChange, onSaved } = setup();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't recognised");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Buffer/), { target: { value: "5" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("blocks double submit while saving", async () => {
    let done: (v: unknown) => void = () => {};
    update.mockReturnValue(new Promise((r) => { done = r; }));
    setup();
    save();
    expect(screen.getByRole("button", { name: /Save settings/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    done({ data: settings, error: null });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  });

  it("cancel closes without saving", () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(update).not.toHaveBeenCalled();
  });
});
