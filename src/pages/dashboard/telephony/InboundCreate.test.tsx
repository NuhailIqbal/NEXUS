import { pick } from "@/test/pick";
import "@/test/radix-stubs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Inbound from "./Inbound";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const PENDING = "nexus_pending_receptionist_hours";

function mock(hoursStatus: object = { available: true, reason: null }) {
  fn(api.getInboundQueues).mockResolvedValue({ data: [], error: null });
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara", status: "Active", vapi_assistant_id: "x" }], error: null });
  fn(api.getPhoneNumbers).mockResolvedValue({ data: [], error: null });
  fn(api.getConversations).mockResolvedValue({ data: [], error: null });
  fn(api.getCallerVerificationStatus).mockResolvedValue({ data: { available: true, reason: null }, error: null });
  fn(api.getAnswerHoursStatus).mockResolvedValue({ data: hoursStatus, error: null });
  fn(api.updatePhoneNumber).mockResolvedValue({ data: {}, error: null });
  fn(api.createInboundQueue).mockResolvedValue({ data: { id: "q9", phone_number_id: "p9" }, error: null });
}

const dialog = () => screen.getByRole("dialog");
const hoursSwitch = () => screen.getByRole("switch", { name: "Only answer during set hours" });
/** Switches the hours on and chooses a time zone (none is pre-selected). */
async function enableHours() {
  fireEvent.click(hoursSwitch());
  await pick("Timezone", "karachi");
}
const button = (name: RegExp | string) => within(dialog()).getByRole("button", { name });

async function openCreate() {
  await screen.findByText("No receptionists yet");
  fireEvent.click(screen.getAllByRole("button", { name: /New Receptionist/ })[0]);
  await screen.findByText(/Step 1 of 2/);
}
async function fillStep1() {
  fireEvent.change(screen.getByPlaceholderText(/Front Desk/), { target: { value: "Front Desk" } });
  fireEvent.click(within(dialog()).getAllByRole("combobox")[0]);
  fireEvent.click(await screen.findByRole("option", { name: "Sara" }));
}
async function toStep2() {
  await openCreate();
  await fillStep1();
  fireEvent.click(button("Next"));
  await screen.findByText(/Step 2 of 2/);
}

beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });
afterEach(() => { sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("New AI Receptionist: two steps", () => {
  it("opens on step 1 of 2 with the name, agent and number, and no hours yet", async () => {
    mock();
    render(<Inbound />);
    await openCreate();
    expect(screen.getByPlaceholderText(/Front Desk/)).toBeInTheDocument();
    expect(within(dialog()).getByText("Phone Number")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Only answer during set hours" })).not.toBeInTheDocument();
    expect(button("Next")).toBeInTheDocument();
    expect(within(dialog()).queryByRole("button", { name: "Create Receptionist" })).not.toBeInTheDocument();
  });

  it("Next needs a name and an agent first", async () => {
    mock();
    render(<Inbound />);
    await openCreate();
    fireEvent.click(button("Next"));
    expect(toast.error).toHaveBeenCalledWith("Name is required");
    fireEvent.change(screen.getByPlaceholderText(/Front Desk/), { target: { value: "Front Desk" } });
    fireEvent.click(button("Next"));
    expect(toast.error).toHaveBeenCalledWith("Select an AI agent");
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();
  });

  it("step 2 is the answering hours, off by default, and Previous keeps what was typed", async () => {
    mock();
    render(<Inbound />);
    await toStep2();
    expect(hoursSwitch()).not.toBeChecked();
    expect(screen.queryByLabelText("Answers from")).not.toBeInTheDocument();
    expect(button("Create Receptionist")).toBeInTheDocument();
    fireEvent.click(hoursSwitch());
    expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
    expect(screen.getByLabelText("Answers from")).toHaveTextContent("9:00 AM");
    expect(screen.getByLabelText("Answers until")).toHaveTextContent("5:00 PM");
    fireEvent.click(button("Previous"));
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Front Desk/)).toHaveValue("Front Desk");
    fireEvent.click(button("Next"));
    await screen.findByText(/Step 2 of 2/);
    expect(hoursSwitch()).toBeChecked();
  });

  it("reopening the dialog starts again on step 1, empty, with the hours off", async () => {
    mock();
    render(<Inbound />);
    await toStep2();
    fireEvent.click(hoursSwitch());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getAllByRole("button", { name: /New Receptionist/ })[0]);
    await screen.findByText(/Step 1 of 2/);
    expect(screen.getByPlaceholderText(/Front Desk/)).toHaveValue("");
    fireEvent.change(screen.getByPlaceholderText(/Front Desk/), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Sara" }));
    fireEvent.click(button("Next"));
    await screen.findByText(/Step 2 of 2/);
    expect(hoursSwitch()).not.toBeChecked();
  });
});

describe("New AI Receptionist: creating with hours", () => {
  it("hours off: the receptionist is created and the number is not touched", async () => {
    mock();
    render(<Inbound />);
    await toStep2();
    fireEvent.click(button("Create Receptionist"));
    await waitFor(() => expect(api.createInboundQueue).toHaveBeenCalled());
    expect(fn(api.createInboundQueue).mock.calls[0][0]).toMatchObject({ name: "Front Desk", agent_id: "a1" });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
  });

  it("the suggestion link fills in the user's time zone, which is then saved", async () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "Asia/Karachi" } as Intl.ResolvedDateTimeFormatOptions);
    try {
      mock();
      render(<Inbound />);
      await toStep2();
      fireEvent.click(hoursSwitch());
      fireEvent.click(screen.getByRole("button", { name: /Use my time zone/ }));
      fireEvent.click(button("Create Receptionist"));
      await waitFor(() => expect(api.updatePhoneNumber).toHaveBeenCalled());
      expect(fn(api.updatePhoneNumber).mock.calls[0][1]).toMatchObject({ answer_hours_timezone: "Asia/Karachi" });
    } finally {
      spy.mockRestore();
    }
  });

  it("hours on without a time zone chosen is refused before anything is created", async () => {
    mock();
    render(<Inbound />);
    await toStep2();
    fireEvent.click(hoursSwitch());
    fireEvent.click(button("Create Receptionist"));
    expect(toast.error).toHaveBeenCalledWith("Select a time zone.");
    expect(api.createInboundQueue).not.toHaveBeenCalled();
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument();
  });

  it("hours on: after creating, they are saved on the receptionist's number", async () => {
    mock();
    render(<Inbound />);
    await toStep2();
    await enableHours();
    fireEvent.click(button("Create Receptionist"));
    await waitFor(() => expect(api.updatePhoneNumber).toHaveBeenCalled());
    expect(api.updatePhoneNumber).toHaveBeenCalledWith("p9", expect.objectContaining({
      answer_hours_enabled: true, answer_hours_timezone: "Asia/Karachi", answer_hours_days: [0, 1, 2, 3, 4], answer_hours_start: "09:00", answer_hours_end: "17:00",
    }));
    expect(fn(api.createInboundQueue).mock.invocationCallOrder[0]).toBeLessThan(fn(api.updatePhoneNumber).mock.invocationCallOrder[0]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("no day selected is refused before anything is created", async () => {
    mock();
    render(<Inbound />);
    await toStep2();
    await enableHours();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(button("Create Receptionist"));
    expect(toast.error).toHaveBeenCalledWith("Pick at least one day.");
    expect(api.createInboundQueue).not.toHaveBeenCalled();
  });

  it("hours the server refuses do not undo the receptionist: the user is told where to retry", async () => {
    mock();
    fn(api.updatePhoneNumber).mockResolvedValue({ data: null, error: "Answering hours aren't available yet." });
    render(<Inbound />);
    await toStep2();
    await enableHours();
    fireEvent.click(button("Create Receptionist"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = fn(toast.error).mock.calls[0][0] as string;
    expect(message).toMatch(/created, but its answering hours were not saved/);
    expect(message).toMatch(/Settings/);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("a failed creation keeps the dialog open and saves no hours", async () => {
    mock();
    fn(api.createInboundQueue).mockResolvedValue({ data: null, error: "Agent not found or not synced" });
    render(<Inbound />);
    await toStep2();
    await enableHours();
    fireEvent.click(button("Create Receptionist"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Agent not found or not synced"));
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    expect(screen.getByText(/Step 2 of 2/)).toBeInTheDocument();
  });

  it("when the server cannot do answering hours, step 2 shows why and the switch stays off", async () => {
    mock({ available: false, reason: "Answering hours aren't available yet. Please contact support." });
    render(<Inbound />);
    await toStep2();
    expect(hoursSwitch()).toBeDisabled();
    expect(dialog()).toHaveTextContent("Answering hours aren't available yet");
  });
});

describe("New AI Receptionist: paying by card first", () => {
  it("keeps the chosen hours across the checkout redirect", async () => {
    mock();
    fn(api.createInboundQueue).mockResolvedValue({ data: { checkout_url: "https://pay.example/c" }, error: null });
    const saved = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...saved, href: "", origin: saved.origin, search: "", pathname: saved.pathname } });
    try {
      render(<Inbound />);
      await toStep2();
      await enableHours();
      fireEvent.click(button("Create Receptionist"));
      await waitFor(() => expect(window.location.href).toBe("https://pay.example/c"));
      expect(JSON.parse(sessionStorage.getItem(PENDING) as string)).toMatchObject({ answer_hours_enabled: true, answer_hours_timezone: "Asia/Karachi", answer_hours_start: "09:00" });
      expect(api.updatePhoneNumber).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: saved });
    }
  });

  it("without hours nothing is kept for the return", async () => {
    mock();
    fn(api.createInboundQueue).mockResolvedValue({ data: { checkout_url: "https://pay.example/c" }, error: null });
    const saved = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...saved, href: "", origin: saved.origin, search: "", pathname: saved.pathname } });
    try {
      render(<Inbound />);
      await toStep2();
      fireEvent.click(button("Create Receptionist"));
      await waitFor(() => expect(window.location.href).toBe("https://pay.example/c"));
      expect(sessionStorage.getItem(PENDING)).toBeNull();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: saved });
    }
  });

  it("on the return from payment the kept hours are put on the new number, once", async () => {
    mock();
    sessionStorage.setItem(PENDING, JSON.stringify({ answer_hours_enabled: true, answer_hours_timezone: "UTC", answer_hours_days: [0, 1], answer_hours_start: "10:00", answer_hours_end: "12:00" }));
    window.history.replaceState({}, "", "/dashboard/telephony/inbound?purchase=success&session_id=cs_1");
    fn(api.confirmPhonePurchase).mockResolvedValue({ data: { id: "p77", number: "+15550007777" }, error: null });
    render(<Inbound />);
    await waitFor(() => expect(api.updatePhoneNumber).toHaveBeenCalledWith("p77", expect.objectContaining({ answer_hours_start: "10:00", answer_hours_days: [0, 1] })));
    expect(sessionStorage.getItem(PENDING)).toBeNull();
    expect(api.updatePhoneNumber).toHaveBeenCalledTimes(1);
  });

  it("if the kept hours are refused on the return, the user is told and the receptionist stays", async () => {
    mock();
    sessionStorage.setItem(PENDING, JSON.stringify({ answer_hours_enabled: true }));
    window.history.replaceState({}, "", "/dashboard/telephony/inbound?purchase=success&session_id=cs_4");
    fn(api.confirmPhonePurchase).mockResolvedValue({ data: { id: "p79", number: "+15550007779" }, error: null });
    fn(api.updatePhoneNumber).mockResolvedValue({ data: null, error: "Answering hours aren't available yet." });
    render(<Inbound />);
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(fn(toast.error).mock.calls[0][0]).toMatch(/created, but its answering hours were not saved.*Settings/);
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining("receptionist created"));
  });

  it("a failed confirmation does not apply the hours to anything", async () => {
    mock();
    sessionStorage.setItem(PENDING, JSON.stringify({ answer_hours_enabled: true }));
    window.history.replaceState({}, "", "/dashboard/telephony/inbound?purchase=success&session_id=cs_2");
    fn(api.confirmPhonePurchase).mockResolvedValue({ data: null, error: "Payment not completed" });
    render(<Inbound />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Payment not completed"));
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
  });

  it("a payment with no kept hours changes nothing on the number", async () => {
    mock();
    window.history.replaceState({}, "", "/dashboard/telephony/inbound?purchase=success&session_id=cs_3");
    fn(api.confirmPhonePurchase).mockResolvedValue({ data: { id: "p78", number: "+15550007778" }, error: null });
    render(<Inbound />);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(api.updatePhoneNumber).not.toHaveBeenCalled();
  });
});
