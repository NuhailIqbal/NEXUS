import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getPhoneNumbers: vi.fn(), getAgents: vi.fn(), getCampaigns: vi.fn(), getCallerVerificationStatus: vi.fn(),
    getCallerVerificationLog: vi.fn(), updatePhoneNumber: vi.fn(), deletePhoneNumber: vi.fn(),
    createPhoneNumber: vi.fn(), createByotPhoneNumber: vi.fn(), confirmPhonePurchase: vi.fn(),
    makeCall: vi.fn(), getCallStatus: vi.fn(), getTwilioCredentials: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import PhoneNumbers from "./PhoneNumbers";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const update = fn(api.updatePhoneNumber);

const num = (over: Record<string, unknown> = {}) => ({
  id: "n1", number: "+15550001111", status: "Active", agent_id: "a1", provider: "twilio", vapi_phone_id: "vp1",
  created_at: "2026-01-01T00:00:00Z", monthly_cost: 3, next_billing_at: null, suspended_for_balance: false,
  caller_verification_enabled: false, twilio_credential_id: null, ...over,
});
const AVAILABLE = { available: true, reason: null };
const UNAVAILABLE = { available: false, reason: "Caller verification isn't available yet. Please contact support." };

function mock(numbers: ReturnType<typeof num>[], status: object | string = AVAILABLE) {
  fn(api.getPhoneNumbers).mockResolvedValue({ data: numbers, error: null });
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara" }, { id: "a2", name: "Omar" }], error: null });
  fn(api.getCampaigns).mockResolvedValue({ data: [], error: null });
  fn(api.getCallerVerificationStatus).mockResolvedValue(
    typeof status === "string" ? { data: null, error: status } : { data: status, error: null },
  );
  fn(api.getCallerVerificationLog).mockResolvedValue({ data: [], error: null });
  update.mockResolvedValue({ data: {}, error: null });
}

const rowFor = (number: string) => screen.getByText(number).closest("tr") as HTMLElement;
async function openSettings(number = "+15550001111") {
  render(<PhoneNumbers />);
  await screen.findByText(number);
  fireEvent.click(within(rowFor(number)).getByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog");
}
const verifySwitch = () => screen.getByRole("switch", { name: "Verify callers before answering" });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));

beforeEach(() => vi.clearAllMocks());

describe("Phone Numbers: caller verification", () => {
  // ── the list ──
  it("marks only the numbers that have caller verification on", async () => {
    mock([num(), num({ id: "n2", number: "+15550002222", caller_verification_enabled: true })]);
    render(<PhoneNumbers />);
    await screen.findByText("+15550002222");
    expect(within(rowFor("+15550002222")).getByText("Caller check")).toBeInTheDocument();
    expect(within(rowFor("+15550001111")).queryByText("Caller check")).not.toBeInTheDocument();
  });

  it("a verified number without an agent answers no one, so it shows no 'Caller check' badge", async () => {
    mock([num({ agent_id: null, caller_verification_enabled: true })]);
    render(<PhoneNumbers />);
    await screen.findByText("+15550001111");
    expect(within(rowFor("+15550001111")).queryByText("Caller check")).not.toBeInTheDocument();
    expect(within(rowFor("+15550001111")).getAllByText("—").length).toBeGreaterThan(0);
  });

  // ── the settings dialog ──
  it("shows the switch off for a number that is not verified", async () => {
    mock([num()]);
    await openSettings();
    expect(verifySwitch()).not.toBeChecked();
    expect(screen.queryByText("Recent checks")).not.toBeInTheDocument();
  });

  it("shows the switch on, with the recent checks, for a verified number", async () => {
    mock([num({ caller_verification_enabled: true })]);
    fn(api.getCallerVerificationLog).mockResolvedValue({
      data: [{ id: "r1", phone_number_id: "n1", caller_number: "+15553334444", decision: "refused", reason: "not_mobile",
               line_type: "landline", created_at: new Date().toISOString() }],
      error: null,
    });
    await openSettings();
    expect(verifySwitch()).toBeChecked();
    expect(await screen.findByText("Recent checks")).toBeInTheDocument();
    expect(await screen.findByText("+15553334444")).toBeInTheDocument();
    expect(screen.getByText("Landline number")).toBeInTheDocument();
    expect(api.getCallerVerificationLog).toHaveBeenCalledWith("phone_number_id=n1&limit=5");
  });

  it("turning it on and saving sends the flag together with the other settings", async () => {
    mock([num()]);
    await openSettings();
    fireEvent.click(verifySwitch());
    expect(verifySwitch()).toBeChecked();
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith("n1", {
      agent_id: "a1", status: "Active", provider: "twilio", caller_verification_enabled: true,
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Number updated"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("turning it off for a verified number sends false", async () => {
    mock([num({ caller_verification_enabled: true })]);
    await openSettings();
    fireEvent.click(verifySwitch());
    expect(verifySwitch()).not.toBeChecked();
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ caller_verification_enabled: false });
  });

  it("does NOT send the flag when it was not changed, so an unrelated save never re-routes the number", async () => {
    for (const enabled of [false, true]) {
      vi.clearAllMocks();
      mock([num({ caller_verification_enabled: enabled })]);
      const { unmount } = render(<PhoneNumbers />);
      await screen.findByText("+15550001111");
      fireEvent.click(within(rowFor("+15550001111")).getByRole("button", { name: "Settings" }));
      await screen.findByRole("dialog");
      save();
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
      expect(update.mock.calls[0][1]).toEqual({ agent_id: "a1", status: "Active", provider: "twilio" });
      unmount();
    }
  }, 15_000); // two full page renders: can pass 5s when the whole suite runs in parallel

  it("toggling twice back to the original value also sends nothing", async () => {
    mock([num()]);
    await openSettings();
    fireEvent.click(verifySwitch());
    fireEvent.click(verifySwitch());
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).not.toHaveProperty("caller_verification_enabled");
  });

  it("Cancel throws the change away; reopening shows the saved value", async () => {
    mock([num()]);
    await openSettings();
    fireEvent.click(verifySwitch());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(update).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(within(rowFor("+15550001111")).getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(verifySwitch()).not.toBeChecked();
  });

  it("each number's dialog starts from that number's own value", async () => {
    mock([num(), num({ id: "n2", number: "+15550002222", caller_verification_enabled: true })]);
    render(<PhoneNumbers />);
    await screen.findByText("+15550002222");
    fireEvent.click(within(rowFor("+15550002222")).getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(verifySwitch()).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(within(rowFor("+15550001111")).getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(verifySwitch()).not.toBeChecked();
  });

  it("refreshes the list after saving so the badge appears", async () => {
    mock([num()]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [num()], error: null })
      .mockResolvedValue({ data: [num({ caller_verification_enabled: true })], error: null });
    await openSettings();
    fireEvent.click(verifySwitch());
    save();
    expect(await within(rowFor("+15550001111")).findByText("Caller check")).toBeInTheDocument();
  });

  // ── failures ──
  it("shows the server's reason and keeps the dialog open when it refuses", async () => {
    mock([num()]);
    update.mockResolvedValue({ data: null, error: "Voice service error. Please try again." });
    await openSettings();
    fireEvent.click(verifySwitch());
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Voice service error. Please try again."));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(verifySwitch()).toBeChecked(); // still the user's pending choice, so they can retry
  });

  it("locks the form while saving and sends only one request however often Save is clicked", async () => {
    mock([num()]);
    let finish: (v: unknown) => void = () => {};
    update.mockReturnValue(new Promise((res) => { finish = res; }));
    await openSettings();
    fireEvent.click(verifySwitch());
    save();
    await waitFor(() => expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled());
    expect(verifySwitch()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // cannot be dismissed mid-save
    await act(async () => { finish({ data: {}, error: null }); });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("unlocks again after a failed save", async () => {
    mock([num()]);
    update.mockResolvedValue({ data: null, error: "nope" });
    await openSettings();
    fireEvent.click(verifySwitch());
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(verifySwitch()).toBeEnabled();
    update.mockResolvedValue({ data: {}, error: null });
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  });

  // ── when the server cannot do it ──
  it("cannot be switched on when the server is not set up, and says why", async () => {
    mock([num()], UNAVAILABLE);
    await openSettings();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(UNAVAILABLE.reason));
    expect(verifySwitch()).toBeDisabled();
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).not.toHaveProperty("caller_verification_enabled");
  });

  it("a number that already has it on can still be switched off when the server is not set up", async () => {
    mock([num({ caller_verification_enabled: true })], UNAVAILABLE);
    await openSettings();
    await waitFor(() => expect(screen.getByRole("switch", { name: "Verify callers before answering" })).toBeEnabled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.click(verifySwitch());
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).toMatchObject({ caller_verification_enabled: false });
  });

  it("stays usable if the status request itself fails (the server then decides)", async () => {
    mock([num()], "Network error");
    await openSettings();
    expect(verifySwitch()).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("the page still loads when the status endpoint returns something unexpected", async () => {
    mock([num()]);
    fn(api.getCallerVerificationStatus).mockResolvedValue({ data: { surprise: true }, error: null });
    render(<PhoneNumbers />);
    expect(await screen.findByText("+15550001111")).toBeInTheDocument();
  });

  it("shows the saved value at once, even while the list is still reloading", async () => {
    mock([num()]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [num()], error: null })
      .mockReturnValue(new Promise(() => {})); // the reload never finishes
    await openSettings();
    fireEvent.click(verifySwitch());
    save();
    expect(await within(rowFor("+15550001111")).findByText("Caller check")).toBeInTheDocument();
    // Reopening before the reload lands starts from what was saved, not the old value.
    fireEvent.click(within(rowFor("+15550001111")).getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    expect(verifySwitch()).toBeChecked();
  });

  it("the server's returned row wins over what was sent", async () => {
    mock([num()]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [num()], error: null })
      .mockReturnValue(new Promise(() => {}));
    update.mockResolvedValue({ data: num({ caller_verification_enabled: false, status: "Inactive" }), error: null });
    await openSettings();
    fireEvent.click(verifySwitch());
    save();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(within(rowFor("+15550001111")).queryByText("Caller check")).not.toBeInTheDocument();
  });

  it("an older reload finishing last cannot bring back stale values", async () => {
    mock([num()]);
    let releaseFirst: (v: unknown) => void = () => {};
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [num()], error: null })
      .mockReturnValueOnce(new Promise((res) => { releaseFirst = res; }))
      .mockResolvedValue({ data: [num({ caller_verification_enabled: true })], error: null });
    await openSettings();
    save(); // an unrelated save: its reload is slow
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(within(rowFor("+15550001111")).getByRole("button", { name: "Settings" }));
    await screen.findByRole("dialog");
    fireEvent.click(verifySwitch());
    save(); // turns it on: its reload is quick
    expect(await within(rowFor("+15550001111")).findByText("Caller check")).toBeInTheDocument();
    await act(async () => { releaseFirst({ data: [num()], error: null }); });
    expect(within(rowFor("+15550001111")).getByText("Caller check")).toBeInTheDocument();
  });

  it("locks the agent and status pickers while saving too", async () => {
    mock([num()]);
    let finish: (v: unknown) => void = () => {};
    update.mockReturnValue(new Promise((res) => { finish = res; }));
    const dialog = await openSettings();
    save();
    await waitFor(() => expect(screen.getByRole("button", { name: /Save/ })).toBeDisabled());
    for (const picker of within(dialog).getAllByRole("combobox")) expect(picker).toBeDisabled();
    await act(async () => { finish({ data: {}, error: null }); });
  });

  it("when the server is not set up, a verified number flipped off can be flipped back on before saving", async () => {
    mock([num({ caller_verification_enabled: true })], UNAVAILABLE);
    await openSettings();
    await waitFor(() => expect(verifySwitch()).toBeEnabled());
    fireEvent.click(verifySwitch());
    expect(verifySwitch()).not.toBeChecked();
    expect(verifySwitch()).toBeEnabled(); // not locked: on is what is in effect
    fireEvent.click(verifySwitch());
    expect(verifySwitch()).toBeChecked();
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][1]).not.toHaveProperty("caller_verification_enabled");
  });

  it("turning it off and changing the agent go out in one request", async () => {
    mock([num({ caller_verification_enabled: true })]);
    const dialog = await openSettings();
    fireEvent.click(verifySwitch());
    fireEvent.click(within(dialog).getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Omar" }));
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith("n1", {
      agent_id: "a2", status: "Active", provider: "twilio", caller_verification_enabled: false,
    });
  });

  it("keeps the existing behaviour: changing the agent saves it as before", async () => {
    mock([num()]);
    const dialog = await openSettings();
    // (The existing "Assigned Agent" label is not linked to its trigger, so find it by position.)
    fireEvent.click(within(dialog).getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Omar" }));
    save();
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update).toHaveBeenCalledWith("n1", { agent_id: "a2", status: "Active", provider: "twilio" });
  });
});
