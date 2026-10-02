import { choose, pick } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { updateCallbackSettings: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CallbackSettingsDialog } from "./CallbackSettingsDialog";
import type { CallbackSettings } from "./callbackTypes";

const settings: CallbackSettings = {
  auto_call: false, timezone: "Asia/Karachi", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "18:00",
  default_time: "10:00", retry_minutes: 30, max_attempts: 2,
};
const update = api.updateCallbackSettings as ReturnType<typeof vi.fn>;

function setup(over: Partial<CallbackSettings> = {}, isOwner = true) {
  const onSaved = vi.fn();
  const onOpenChange = vi.fn();
  render(<CallbackSettingsDialog open onOpenChange={onOpenChange} settings={{ ...settings, ...over }} isOwner={isOwner} onSaved={onSaved} />);
  return { onSaved, onOpenChange };
}
const save = () => fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
const autoSwitch = () => screen.getByRole("switch", { name: "Place callbacks automatically" });

beforeEach(() => vi.clearAllMocks());

describe("CallbackSettingsDialog", () => {
  it("lets the owner pick Eastern Time from the list", async () => {
    setup();
    await pick("Timezone", "est");
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Eastern Time/);
  });

  it("shows the current settings with auto-calling off", () => {
    setup();
    expect(autoSwitch()).not.toBeChecked();
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
    expect(screen.getByLabelText("Calls start")).toHaveTextContent("9:00 AM");
    expect(screen.getByLabelText("Calls stop")).toHaveTextContent("6:00 PM");
    expect(screen.getByLabelText("Default time")).toHaveTextContent("10:00 AM");
    expect(screen.getByLabelText(/Retry after/)).toHaveValue(30);
    expect(screen.getByLabelText(/Attempts/)).toHaveValue(2);
  });

  it("changing other settings saves without any confirmation and without turning auto-call on", async () => {
    update.mockResolvedValue({ data: { ...settings, retry_minutes: 45 }, error: null });
    const { onSaved } = setup();
    fireEvent.change(screen.getByLabelText(/Retry after/), { target: { value: "45" } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ retry_minutes: 45, auto_call: false }));
    expect(screen.queryByText("Turn on automatic callbacks?")).not.toBeInTheDocument();
  });

  it("turning auto-calling ON asks first, and Not yet saves nothing", async () => {
    setup();
    fireEvent.click(autoSwitch());
    save();
    expect(await screen.findByText("Turn on automatic callbacks?")).toBeInTheDocument();
    const confirm = screen.getByRole("alertdialog");
    expect(confirm).toHaveTextContent(/real phone calls/);
    expect(confirm).toHaveTextContent(/wallet balance/);
    expect(confirm).toHaveTextContent(/do-not-call/);
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Not yet" }));
    expect(update).not.toHaveBeenCalled();
  });

  it("confirming turns it on and saves", async () => {
    update.mockResolvedValue({ data: { ...settings, auto_call: true }, error: null });
    const { onSaved, onOpenChange } = setup();
    fireEvent.click(autoSwitch());
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ auto_call: true })));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ auto_call: true }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("Callback settings saved");
  });

  it("an account that already has it on is not asked again, and can turn it off freely", async () => {
    update.mockResolvedValue({ data: { ...settings, auto_call: false }, error: null });
    const { onSaved } = setup({ auto_call: true });
    expect(autoSwitch()).toBeChecked();
    fireEvent.click(autoSwitch());
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ auto_call: false }));
  });

  it("an invalid form is refused before anything is sent, even when turning auto-call on", async () => {
    setup();
    fireEvent.click(autoSwitch());
    await choose("Default time", "8:00 PM");
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/inside your calling hours/);
    expect(screen.queryByText("Turn on automatic callbacks?")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it("calling days toggle and at least one is required", () => {
    setup();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    save();
    expect(screen.getByRole("alert")).toHaveTextContent(/calling day/);
    expect(update).not.toHaveBeenCalled();
  });

  it("a server error shows inline, keeps the dialog open and clears on the next edit", async () => {
    update.mockResolvedValue({ data: null, error: "That timezone isn't recognised." });
    const { onSaved, onOpenChange } = setup();
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't recognised");
    expect(onSaved).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    fireEvent.change(screen.getByLabelText(/Attempts/), { target: { value: "3" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a failed save after confirming leaves auto-calling as it was and shows the error", async () => {
    update.mockResolvedValue({ data: null, error: "boom" });
    const { onSaved } = setup();
    fireEvent.click(autoSwitch());
    save();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("non-owners see the settings but cannot change or save them", () => {
    setup({}, false);
    expect(autoSwitch()).toBeDisabled();
    expect(screen.getByLabelText("Timezone")).toBeDisabled();
    expect(screen.getByLabelText(/Retry after/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mon" })).toBeDisabled();
    expect(screen.getByText(/Only the account owner can change these settings/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save settings/ })).not.toBeInTheDocument();
  });

  it("an account on UTC (missing from many browser lists) can still save", async () => {
    update.mockResolvedValue({ data: { ...settings, timezone: "UTC" }, error: null });
    const { onSaved } = setup({ timezone: "UTC" });
    fireEvent.change(screen.getByLabelText(/Attempts/), { target: { value: "3" } });
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
