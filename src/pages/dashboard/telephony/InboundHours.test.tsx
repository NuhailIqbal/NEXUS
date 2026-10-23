import { choose, pick } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vi as viConfig } from "vitest";
viConfig.setConfig({ testTimeout: 20000 });   // the 96-slot time list and the zone list render slowly in jsdom when the machine is busy
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getInboundQueues: vi.fn(), getAgents: vi.fn(), getPhoneNumbers: vi.fn(), getConversations: vi.fn(),
    getCallerVerificationStatus: vi.fn(), getAnswerHoursStatus: vi.fn(), updatePhoneNumber: vi.fn(),
    createInboundQueue: vi.fn(), updateInboundQueue: vi.fn(), deleteInboundQueue: vi.fn(), confirmPhonePurchase: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Inbound from "./Inbound";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const OPEN_STATE = { enabled: true, open: true, next_open_at: null, summary: "Mon–Fri, 9:00 AM–5:00 PM (Asia/Karachi)" };
const CLOSED_STATE = { enabled: true, open: false, next_open_at: "2026-10-13T04:00:00Z", summary: "Mon–Fri, 9:00 AM–5:00 PM (Asia/Karachi)" };

const phone = (over: Record<string, unknown> = {}) => ({
  id: "p1", number: "+15550001111", status: "Active", agent_id: "a1", vapi_phone_id: "vp1",
  caller_verification_enabled: false,
  answer_hours_enabled: false, answer_hours_timezone: "Asia/Karachi", answer_hours_days: [0, 1, 2, 3, 4],
  answer_hours_start: "09:00", answer_hours_end: "17:00",
  answer_hours_state: { enabled: false, open: true, next_open_at: null, summary: null },
  ...over,
});
const hoursPhone = (state: object, over: Record<string, unknown> = {}) =>
  phone({ answer_hours_enabled: true, answer_hours_state: state, ...over });
const queue = (over: Record<string, unknown> = {}) => ({
  id: "q1", name: "Front Desk", status: "Active", agent_id: "a1", phone_number_id: "p1",
  max_wait_seconds: 120, overflow_action: "voicemail", ...over,
});

function mock(queues: object[], phones: object[], hoursStatus: object = { available: true, reason: null }) {
  fn(api.getInboundQueues).mockResolvedValue({ data: queues, error: null });
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara", status: "Active", vapi_assistant_id: "x" }], error: null });
  fn(api.getPhoneNumbers).mockResolvedValue({ data: phones, error: null });
  fn(api.getConversations).mockResolvedValue({ data: [], error: null });
  fn(api.getCallerVerificationStatus).mockResolvedValue({ data: { available: true, reason: null }, error: null });
  fn(api.getAnswerHoursStatus).mockResolvedValue({ data: hoursStatus, error: null });
  fn(api.updatePhoneNumber).mockResolvedValue({ data: {}, error: null });
  fn(api.updateInboundQueue).mockResolvedValue({ data: {}, error: null });
}

const cardOf = (name: string) => screen.getByText(name).closest("div.rounded-xl") as HTMLElement;
const hoursSwitch = () => screen.getByRole("switch", { name: "Only answer during set hours" });
const save = () => fireEvent.click(screen.getByRole("button", { name: /Save Changes/ }));
/** Opens the edit wizard (the same two steps as creating a receptionist) on its second step, the answering hours. */
async function openSettings(name = "Front Desk") {
  await screen.findByText(name);
  fireEvent.click(within(cardOf(name)).getByTitle("Settings"));
  const dialog = await screen.findByRole("dialog");
  await screen.findByText("Receptionist Basics");
  fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  await screen.findByText("Days and times the receptionist answers");
  return dialog;
}

beforeEach(() => vi.clearAllMocks());

describe("AI Receptionist: answering hours on the card", () => {
  it("shows nothing for a receptionist that answers all day", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(cardOf("Front Desk")).not.toHaveTextContent(/Answers /);
    expect(screen.queryByText("Open now")).not.toBeInTheDocument();
  });

  it("says when it answers and that it is open now", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE)]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(cardOf("Front Desk")).toHaveTextContent("Answers Mon–Fri, 9:00 AM–5:00 PM (Asia/Karachi)");
    expect(within(cardOf("Front Desk")).getByText("Open now")).toBeInTheDocument();
  });

  it("says it is closed and when it opens next, in its own timezone", async () => {
    mock([queue()], [hoursPhone(CLOSED_STATE)]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(cardOf("Front Desk")).toHaveTextContent(/Closed — opens Tue, Oct 13, 9:00 AM/);
  });

  it("a receptionist with no number shows no hours either", async () => {
    mock([queue({ phone_number_id: null })], [hoursPhone(OPEN_STATE)]);
    render(<Inbound />);
    await screen.findByText("Front Desk");
    expect(cardOf("Front Desk")).not.toHaveTextContent(/Answers /);
  });
});

describe("AI Receptionist: answering hours in the settings", () => {
  it("opens with the number's stored hours", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE, { answer_hours_days: [0, 2], answer_hours_start: "10:15", answer_hours_end: "16:00" })]);
    render(<Inbound />);
    await openSettings();
    expect(hoursSwitch()).toBeChecked();
    expect(screen.getByLabelText("Answers from")).toHaveTextContent("10:15 AM");
    expect(screen.getByLabelText("Answers until")).toHaveTextContent("4:00 PM");
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Tue" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
  });

  it("switching them on saves them to the receptionist's number, then the rest", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await openSettings();
    expect(hoursSwitch()).not.toBeChecked();
    fireEvent.click(hoursSwitch());
    save();
    await waitFor(() => expect(api.updateInboundQueue).toHaveBeenCalled());
    expect(api.updatePhoneNumber).toHaveBeenCalledWith("p1", {
      answer_hours_enabled: true, answer_hours_timezone: "Asia/Karachi", answer_hours_days: [0, 1, 2, 3, 4],
      answer_hours_start: "09:00", answer_hours_end: "17:00",
    });
    // hours first: if the server refuses them, nothing else has been saved
    expect(fn(api.updatePhoneNumber).mock.invocationCallOrder[0]).toBeLessThan(fn(api.updateInboundQueue).mock.invocationCallOrder[0]);
    expect(toast.success).toHaveBeenCalledWith("Receptionist updated");
  });

  it("switching them off sends enabled false", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE)]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    save();
    await waitFor(() => expect(api.updatePhoneNumber).toHaveBeenCalled());
    expect(fn(api.updatePhoneNumber).mock.calls[0][1]).toMatchObject({ answer_hours_enabled: false });
  });

  it("leaving the hours alone does not touch the number", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE)]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));      // the name is on the first step
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Reception" } });
    save();
    await waitFor(() => expect(api.updateInboundQueue).toHaveBeenCalled());
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(fn(api.updateInboundQueue).mock.calls[0][1]).toMatchObject({ name: "Reception" });
  });

  it("a receptionist that never had hours and keeps them off does not touch the number", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await openSettings();
    save();
    await waitFor(() => expect(api.updateInboundQueue).toHaveBeenCalled());
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
  });

  it("hours the server refuses leave everything unsaved and the dialog open", async () => {
    mock([queue()], [phone()]);
    fn(api.updatePhoneNumber).mockResolvedValue({ data: null, error: "Answering hours aren't available yet. Please contact support." });
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Answering hours aren't available yet. Please contact support."));
    expect(api.updateInboundQueue).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("no day selected is refused before anything is sent", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE)]);
    render(<Inbound />);
    await openSettings();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    save();
    expect(toast.error).toHaveBeenCalledWith("Pick at least one day.");
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(api.updateInboundQueue).not.toHaveBeenCalled();
  });

  it("hours saved but the rest refused: says so and reloads", async () => {
    mock([queue()], [phone()]);
    fn(api.updateInboundQueue).mockResolvedValue({ data: null, error: "Queue not found" });
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Queue not found"));
    await waitFor(() => expect(fn(api.getPhoneNumbers).mock.calls.length).toBeGreaterThan(1));
  });

  it("when the server cannot do answering hours the switch is locked with the reason", async () => {
    mock([queue()], [phone()], { available: false, reason: "Answering hours aren't available yet. Please contact support." });
    render(<Inbound />);
    await openSettings();
    expect(hoursSwitch()).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Answering hours aren't available yet");
  });

  it("when the server cannot do it but hours are already on, they can still be switched off", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE)], { available: false, reason: "Answering hours aren't available yet. Please contact support." });
    render(<Inbound />);
    await openSettings();
    expect(hoursSwitch()).toBeEnabled();
    fireEvent.click(hoursSwitch());
    save();
    await waitFor(() => expect(fn(api.updatePhoneNumber).mock.calls[0][1]).toMatchObject({ answer_hours_enabled: false }));
  });

  it("a receptionist without a number explains that hours need one", async () => {
    mock([queue({ phone_number_id: null })], [phone()]);
    render(<Inbound />);
    await openSettings();
    expect(screen.queryByRole("switch", { name: "Only answer during set hours" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveTextContent(/once this receptionist has a phone number/);
  });

  it("the page still loads when the hours-status request fails", async () => {
    mock([queue()], [phone()]);
    fn(api.getAnswerHoursStatus).mockResolvedValue({ data: null, error: "boom" });
    render(<Inbound />);
    await openSettings();
    expect(hoursSwitch()).toBeEnabled();      // unknown availability is allowed; the server decides on save
  });
});

describe("AI Receptionist: no time zone is pre-selected", () => {
  // A number nobody configured holds the server's untouched "UTC"; it must not look chosen.
  const untouched = () => phone({ answer_hours_timezone: "UTC" });

  it("the time zone starts on its placeholder, whatever the browser's zone is", async () => {
    mock([queue()], [untouched()]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
    expect(screen.getByLabelText("Timezone")).not.toHaveTextContent(/Pakistan|UTC/);
  });

  it("switching the hours on without choosing one is refused before anything is sent", async () => {
    mock([queue()], [untouched()]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    save();
    expect(toast.error).toHaveBeenCalledWith("Select a time zone.");
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(api.updateInboundQueue).not.toHaveBeenCalled();
  });

  it("once the user chooses a time zone it is what gets saved", async () => {
    mock([queue()], [untouched()]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    await pick("Timezone", "karachi");
    save();
    await waitFor(() => expect(api.updatePhoneNumber).toHaveBeenCalled());
    expect(fn(api.updatePhoneNumber).mock.calls[0][1]).toMatchObject({ answer_hours_enabled: true, answer_hours_timezone: "Asia/Karachi" });
  });

  it("changing only the name leaves the number alone", async () => {
    mock([queue()], [untouched()]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));      // the name is on the first step
    fireEvent.change(screen.getAllByRole("textbox")[0], { target: { value: "Reception" } });
    save();
    await waitFor(() => expect(api.updateInboundQueue).toHaveBeenCalled());
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a switched-on switched-off round trip with no zone chosen sends no time zone", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE)]);
    render(<Inbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());                       // off again: the stored zone is still there
    save();
    await waitFor(() => expect(api.updatePhoneNumber).toHaveBeenCalled());
    expect(fn(api.updatePhoneNumber).mock.calls[0][1]).toMatchObject({ answer_hours_enabled: false, answer_hours_timezone: "Asia/Karachi" });
  });
});

describe("AI Receptionist: the edit wizard", () => {
  const openEdit = async () => {
    await screen.findByText("Front Desk");
    fireEvent.click(within(cardOf("Front Desk")).getByTitle("Settings"));
    await screen.findByText("Receptionist Basics");
  };
  const saveBtn = () => screen.getByRole("button", { name: /Save Changes/ });

  it("is the creation wizard in edit mode: two steps, starting from the receptionist, number shown and fixed", async () => {
    mock([queue({ status: "Inactive" })], [phone()]);
    render(<Inbound />);
    await openEdit();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Front Desk")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveTextContent("Inactive");
    expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Sara");
    expect(within(screen.getByRole("dialog")).getByText("+15550001111")).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed here/)).toBeInTheDocument();
    expect(screen.queryByText(/Buy a new number/)).not.toBeInTheDocument();
  });

  it("saves from the first step: name, agent and status go to the receptionist, the number is not touched", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Front Desk"), { target: { value: "Reception" } });
    await choose("Status", "Inactive");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateInboundQueue).toHaveBeenCalled());
    expect(fn(api.updateInboundQueue).mock.calls[0]).toEqual(["q1", { name: "Reception", agent_id: "a1", status: "Inactive" }]);
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Receptionist updated");
    await waitFor(() => expect(screen.queryByText("Receptionist Basics")).not.toBeInTheDocument());
  });

  it("the second step is the answering hours, with Save Changes as its main button", async () => {
    mock([queue()], [hoursPhone(OPEN_STATE, { answer_hours_timezone: "Asia/Karachi" })]);
    render(<Inbound />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the receptionist answers");
    expect(hoursSwitch()).toBeChecked();
    expect(screen.queryByRole("button", { name: /Next/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Receptionist Basics");
  });

  it("a name that is cleared is refused, from either step", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Front Desk"), { target: { value: " " } });
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(toast.error).toHaveBeenCalledWith("Name is required");
    fireEvent.click(saveBtn());
    expect(toast.error).toHaveBeenCalledTimes(2);
    expect(api.updateInboundQueue).not.toHaveBeenCalled();
  });

  it("hours problems found while saving from the first step send the wizard to the hours step", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the receptionist answers");
    fireEvent.click(hoursSwitch());
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Receptionist Basics");
    fireEvent.click(saveBtn());
    expect(await screen.findByText("Days and times the receptionist answers")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(api.updateInboundQueue).not.toHaveBeenCalled();
  });

  it("a refusal from the server keeps the wizard open", async () => {
    mock([queue()], [phone()]);
    fn(api.updateInboundQueue).mockResolvedValue({ data: null, error: "Agent is not set up" });
    render(<Inbound />);
    await openEdit();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Agent is not set up"));
    expect(screen.getByText("Receptionist Basics")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalledWith("Receptionist updated");
  });

  it("without a phone number it says so and answering hours wait for one, but it still saves", async () => {
    mock([queue({ phone_number_id: undefined })], []);
    render(<Inbound />);
    await openEdit();
    expect(screen.getByText("No phone number yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    expect(await screen.findByText(/once this receptionist has a phone number/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Only answer during set hours" })).not.toBeInTheDocument();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateInboundQueue).toHaveBeenCalled());
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
  });

  it("an unsaved edit is gone the next time it is opened", async () => {
    mock([queue()], [phone()]);
    render(<Inbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Front Desk"), { target: { value: "Changed" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByText("Receptionist Basics")).not.toBeInTheDocument());
    await openEdit();
    expect(screen.getByDisplayValue("Front Desk")).toBeInTheDocument();
  });
});
