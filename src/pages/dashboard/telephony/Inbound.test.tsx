import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getInboundQueues: vi.fn(), getAgents: vi.fn(), getPhoneNumbers: vi.fn(), getConversations: vi.fn(),
    getCallerVerificationStatus: vi.fn(), getAnswerHoursStatus: vi.fn(), updatePhoneNumber: vi.fn(), createInboundQueue: vi.fn(),
    updateInboundQueue: vi.fn(), deleteInboundQueue: vi.fn(), confirmPhonePurchase: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Inbound from "./Inbound";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const updateNumber = fn(api.updatePhoneNumber);

const phone = (over: Record<string, unknown> = {}) => ({
  id: "p1", number: "+15550001111", status: "Active", agent_id: "a1", vapi_phone_id: "vp1",
  caller_verification_enabled: false, ...over,
});
const queue = (over: Record<string, unknown> = {}) => ({
  id: "q1", name: "Front Desk", status: "Active", agent_id: "a1", phone_number_id: "p1",
  max_wait_seconds: 120, overflow_action: "voicemail", ...over,
});
const AVAILABLE = { available: true, reason: null };
const UNAVAILABLE = { available: false, reason: "Caller verification isn't available yet. Please contact support." };

function mock(queues: object[], phones: object[], status: object | string = AVAILABLE) {
  fn(api.getInboundQueues).mockResolvedValue({ data: queues, error: null });
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara", status: "Active", vapi_assistant_id: "x" }], error: null });
  fn(api.getPhoneNumbers).mockResolvedValue({ data: phones, error: null });
  fn(api.getConversations).mockResolvedValue({ data: [], error: null });
  fn(api.getCallerVerificationStatus).mockResolvedValue(
    typeof status === "string" ? { data: null, error: status } : { data: status, error: null },
  );
  fn(api.getAnswerHoursStatus).mockResolvedValue({ data: AVAILABLE, error: null });
  updateNumber.mockResolvedValue({ data: {}, error: null });
}

const cardOf = (name: string) => screen.getByText(name).closest("div.rounded-xl") as HTMLElement;
const switchIn = (el: HTMLElement) => within(el).getByRole("switch", { name: "Verify callers before answering" });

beforeEach(() => vi.clearAllMocks());

describe("AI Receptionist: caller verification", () => {
  it("shows the switch on each receptionist's card, reflecting its number", async () => {
    mock(
      [queue(), queue({ id: "q2", name: "Sales Line", phone_number_id: "p2" })],
      [phone(), phone({ id: "p2", number: "+15550002222", caller_verification_enabled: true })],
    );
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(switchIn(cardOf("Front Desk"))).not.toBeChecked();
    expect(switchIn(cardOf("Sales Line"))).toBeChecked();
  });

  it("a receptionist with no linked number has no switch to flip", async () => {
    mock([queue({ phone_number_id: null })], [phone()]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.getByText("No phone number linked yet")).toBeInTheDocument();
  });

  it("a receptionist whose number is missing from the list has no switch either", async () => {
    mock([queue({ phone_number_id: "gone" })], [phone()]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("turning it on updates that number only, tells the user, and shows the new state", async () => {
    mock([queue()], [phone()]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [phone()], error: null })
      .mockResolvedValue({ data: [phone({ caller_verification_enabled: true })], error: null });
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(updateNumber).toHaveBeenCalledExactlyOnceWith("p1", { caller_verification_enabled: true }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Caller verification turned on"));
    await waitFor(() => expect(switchIn(cardOf("Front Desk"))).toBeChecked());
  });

  it("keeps the new value on screen while the list reloads", async () => {
    mock([queue()], [phone()]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [phone()], error: null })
      .mockReturnValue(new Promise(() => {})); // the reload never finishes
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Caller verification turned on"));
    // released, and showing what was saved, not snapping back to the old value
    expect(switchIn(cardOf("Front Desk"))).toBeEnabled();
    expect(switchIn(cardOf("Front Desk"))).toBeChecked();
  });

  it("keeps the new value if the reload fails", async () => {
    mock([queue()], [phone()]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [phone()], error: null })
      .mockResolvedValue({ data: null, error: "Network error" });
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(api.getPhoneNumbers).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(switchIn(cardOf("Front Desk"))).toBeChecked();
    expect(switchIn(cardOf("Front Desk"))).toBeEnabled();
  });

  it("never shows the old value between the save and the reload", async () => {
    mock([queue()], [phone()]);
    let releaseReload: (v: unknown) => void = () => {};
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [phone()], error: null })
      .mockReturnValue(new Promise((res) => { releaseReload = res; }));
    const seen: boolean[] = [];
    render(<Inbound />);
    await screen.findByText("Front Desk");
    const observer = new MutationObserver(() => seen.push(switchIn(cardOf("Front Desk")).getAttribute("aria-checked") === "true"));
    observer.observe(cardOf("Front Desk"), { attributes: true, subtree: true, attributeFilter: ["aria-checked"] });
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await act(async () => { releaseReload({ data: [phone({ caller_verification_enabled: true })], error: null }); });
    observer.disconnect();
    expect(seen.every(Boolean)).toBe(true); // every observed state was "on": it never flickered back off
    expect(switchIn(cardOf("Front Desk"))).toBeChecked();
  });

  it("an older reload finishing last cannot bring back a stale value", async () => {
    mock([queue()], [phone()]);
    let releaseFirst: (v: unknown) => void = () => {};
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [phone()], error: null })
      .mockReturnValueOnce(new Promise((res) => { releaseFirst = res; }))   // after turning it on: slow
      .mockResolvedValue({ data: [phone()], error: null });                 // after turning it off: quick
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Caller verification turned on"));
    await waitFor(() => expect(switchIn(cardOf("Front Desk"))).toBeEnabled());
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Caller verification turned off"));
    await waitFor(() => expect(api.getPhoneNumbers).toHaveBeenCalledTimes(3));
    await act(async () => { releaseFirst({ data: [phone({ caller_verification_enabled: true })], error: null }); });
    expect(switchIn(cardOf("Front Desk"))).not.toBeChecked();
  });

  it("turning it off sends false", async () => {
    mock([queue()], [phone({ caller_verification_enabled: true })]);
    fn(api.getPhoneNumbers)
      .mockResolvedValueOnce({ data: [phone({ caller_verification_enabled: true })], error: null })
      .mockResolvedValue({ data: [phone()], error: null });
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(updateNumber).toHaveBeenCalledExactlyOnceWith("p1", { caller_verification_enabled: false }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Caller verification turned off"));
    await waitFor(() => expect(switchIn(cardOf("Front Desk"))).not.toBeChecked());
  });

  it("only the clicked card's number is changed", async () => {
    mock(
      [queue(), queue({ id: "q2", name: "Sales Line", phone_number_id: "p2" })],
      [phone(), phone({ id: "p2", number: "+15550002222" })],
    );
    render(<Inbound />);
    await screen.findByText("Sales Line");
    fireEvent.click(switchIn(cardOf("Sales Line")));
    await waitFor(() => expect(updateNumber).toHaveBeenCalledTimes(1));
    expect(updateNumber.mock.calls[0][0]).toBe("p2");
  });

  it("when the server refuses, the reason is shown and the switch goes back to what is really in effect", async () => {
    mock([queue()], [phone()]);
    updateNumber.mockResolvedValue({ data: null, error: "Voice service error. Please try again." });
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Voice service error. Please try again."));
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(switchIn(cardOf("Front Desk"))).toBeEnabled());
    expect(switchIn(cardOf("Front Desk"))).not.toBeChecked();
  });

  it("shows the pending value while saving, locks every switch, and ignores clicks until it is done", async () => {
    mock(
      [queue(), queue({ id: "q2", name: "Sales Line", phone_number_id: "p2" })],
      [phone(), phone({ id: "p2", number: "+15550002222" })],
    );
    let finish: (v: unknown) => void = () => {};
    updateNumber.mockReturnValue(new Promise((res) => { finish = res; }));
    render(<Inbound />);
    await screen.findByText("Front Desk");
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(switchIn(cardOf("Front Desk"))).toBeChecked());   // pending value
    expect(switchIn(cardOf("Front Desk"))).toBeDisabled();
    expect(switchIn(cardOf("Sales Line"))).toBeDisabled();                     // no overlapping saves
    expect(switchIn(cardOf("Sales Line"))).not.toBeChecked();
    fireEvent.click(switchIn(cardOf("Front Desk")));
    fireEvent.click(switchIn(cardOf("Sales Line")));
    expect(updateNumber).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ data: {}, error: null }); });
    await waitFor(() => expect(switchIn(cardOf("Sales Line"))).toBeEnabled());
  });

  it("cannot be switched on when the server is not set up, and says why", async () => {
    mock([queue()], [phone()], UNAVAILABLE);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    await waitFor(() => expect(within(cardOf("Front Desk")).getByRole("status")).toHaveTextContent(UNAVAILABLE.reason));
    expect(switchIn(cardOf("Front Desk"))).toBeDisabled();
    fireEvent.click(switchIn(cardOf("Front Desk")));
    expect(updateNumber).not.toHaveBeenCalled();
  });

  it("a number that is already on can still be switched off when the server is not set up", async () => {
    mock([queue()], [phone({ caller_verification_enabled: true })], UNAVAILABLE);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    await waitFor(() => expect(switchIn(cardOf("Front Desk"))).toBeEnabled());
    fireEvent.click(switchIn(cardOf("Front Desk")));
    await waitFor(() => expect(updateNumber).toHaveBeenCalledWith("p1", { caller_verification_enabled: false }));
  });

  it("the page still loads when the status request fails", async () => {
    mock([queue()], [phone()], "Network error");
    render(<Inbound />);
    expect(await screen.findByText("Front Desk")).toBeInTheDocument();
    expect(switchIn(cardOf("Front Desk"))).toBeEnabled();
  });

  it("shows the short explanation on the card", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    const card = cardOf("Front Desk");
    expect(within(card).getByText(/Only mobile numbers reach your agent/)).toBeInTheDocument();
  });
});
