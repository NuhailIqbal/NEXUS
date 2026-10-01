import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getCalendarStatus: vi.fn(), getMyRole: vi.fn(), createTwilioCredential: vi.fn() },
}));
vi.mock("./calendarConnect", () => ({ startGoogleConnect: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { startGoogleConnect } from "./calendarConnect";
import { AddIntegrationDialog } from "./AddIntegrationDialog";
import type { CalendarStatus } from "./calendarTypes";

const settings = {
  timezone: "UTC", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "17:00",
  slot_minutes: 30, buffer_minutes: 0, min_notice_hours: 2, max_days_ahead: 30,
};
const status = (over: Partial<CalendarStatus> = {}): CalendarStatus => ({
  configured: true, redirect_uri: "https://api.example.com/calendar/google/callback",
  connected: false, status: null, email: null, settings, ...over,
});
const mockCalendar = (s: CalendarStatus, owner = true) => {
  (api.getCalendarStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: s, error: null });
  (api.getMyRole as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { is_owner: owner }, error: null });
};
const connect = startGoogleConnect as ReturnType<typeof vi.fn>;

function setup() {
  const onCreate = vi.fn();
  const onOpenChange = vi.fn();
  const onTwilioConnected = vi.fn();
  render(<AddIntegrationDialog open onOpenChange={onOpenChange} onCreate={onCreate} onTwilioConnected={onTwilioConnected} />);
  return { onCreate, onOpenChange, onTwilioConnected };
}

/** Radix Select in jsdom: open with the keyboard, pick an option with Enter. */
async function chooseType(label: RegExp | string) {
  const trigger = screen.getByRole("combobox", { name: "Integration type" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await screen.findByRole("option", { name: label });
  fireEvent.keyDown(option, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
}
const next = () => fireEvent.click(screen.getByRole("button", { name: /Next/ }));

beforeEach(() => {
  vi.clearAllMocks();
  mockCalendar(status());
  connect.mockResolvedValue(null);
});

describe("Add Integration — Google Calendar", () => {
  it("is offered in the type list", async () => {
    setup();
    const trigger = screen.getByRole("combobox", { name: "Integration type" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Google Calendar" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Brevo/ })).toBeInTheDocument();         // others still there
  });

  it("choosing it drops the name/description fields and lets you continue without them", async () => {
    setup();
    expect(screen.getByPlaceholderText("e.g., My Custom API")).toBeInTheDocument();
    await chooseType("Google Calendar");
    expect(screen.queryByPlaceholderText("e.g., My Custom API")).not.toBeInTheDocument();
    expect(screen.getByText(/Click Next to see how/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeEnabled();
  });

  it("the progress bar has two steps for a calendar (Google takes over after that)", async () => {
    setup();
    await chooseType("Google Calendar");
    const dots = () => document.querySelectorAll(".rounded-full.h-9");
    expect(dots().length).toBe(2);
  });

  it("does not look up the calendar until you reach the steps", async () => {
    setup();
    await chooseType("Google Calendar");
    expect(api.getCalendarStatus).not.toHaveBeenCalled();
    next();
    await waitFor(() => expect(api.getCalendarStatus).toHaveBeenCalledTimes(1));
  });

  it("ready: shows the steps and a Connect with Google button that starts the sign-in", async () => {
    setup();
    await chooseType("Google Calendar");
    next();
    expect(await screen.findByText(/never reads your event titles/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect with Google" }));
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("while redirecting the button is disabled (no double sign-in)", async () => {
    connect.mockReturnValue(new Promise(() => {}));
    setup();
    await chooseType("Google Calendar");
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with Google" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Connect with Google/ })).toBeDisabled());
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("a failure to start is reported and the button works again", async () => {
    connect.mockResolvedValue("Google Calendar isn't set up on this server yet.");
    setup();
    await chooseType("Google Calendar");
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Connect with Google" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Google Calendar isn't set up on this server yet."));
    expect(screen.getByRole("button", { name: "Connect with Google" })).toBeEnabled();
  });

  it("server not configured: shows the Google Cloud steps and only a Close button", async () => {
    mockCalendar(status({ configured: false }));
    setup();
    await chooseType("Google Calendar");
    next();
    expect(await screen.findByText(/One-time setup needed first/)).toBeInTheDocument();
    expect(screen.getByLabelText("redirect URI")).toHaveTextContent("https://api.example.com/calendar/google/callback");
    expect(screen.queryByRole("button", { name: /Connect with Google/ })).not.toBeInTheDocument();
    // the footer's text button (the header X and Radix's own hidden one are icon-only)
    expect(screen.getAllByRole("button", { name: "Close" }).some((b) => b.textContent?.trim() === "Close")).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  });

  it("already connected: says so and offers only Close", async () => {
    mockCalendar(status({ connected: true, status: "connected", email: "o@g.com" }));
    setup();
    await chooseType("Google Calendar");
    next();
    expect(await screen.findByText(/already connected as o@g.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with Google/ })).not.toBeInTheDocument();
  });

  it("expired connection: offers Reconnect with Google", async () => {
    mockCalendar(status({ connected: true, status: "reauth_required" }));
    setup();
    await chooseType("Google Calendar");
    next();
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect with Google" }));
    await waitFor(() => expect(connect).toHaveBeenCalled());
  });

  it("non-owner cannot connect", async () => {
    mockCalendar(status(), false);
    setup();
    await chooseType("Google Calendar");
    next();
    expect(await screen.findByText(/Only the account owner can connect a calendar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /with Google/ })).not.toBeInTheDocument();
  });

  it("status load failure shows a retry that works", async () => {
    (api.getCalendarStatus as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ data: null, error: "Network error" })
      .mockResolvedValue({ data: status(), error: null });
    (api.getMyRole as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { is_owner: true }, error: null });
    setup();
    await chooseType("Google Calendar");
    next();
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Connect with Google" })).toBeInTheDocument();
  });

  it("Previous goes back, and switching to another type brings the name field back", async () => {
    setup();
    await chooseType("Google Calendar");
    next();
    await screen.findByText(/never reads your event titles/);
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await chooseType(/Brevo/);
    expect(screen.getByPlaceholderText("e.g., My Custom API")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();            // name required again
  });

  it("closing and reopening starts clean", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(<AddIntegrationDialog open onOpenChange={onOpenChange} />);
    await chooseType("Google Calendar");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    rerender(<AddIntegrationDialog open onOpenChange={onOpenChange} />);
    expect(screen.getByPlaceholderText("e.g., My Custom API")).toBeInTheDocument();
  });
});

describe("Add Integration — existing types are unchanged", () => {
  it("Brevo still needs a name, then credentials, then creates", async () => {
    const { onCreate } = setup();
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();
    await chooseType(/Brevo/);
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled();           // still no name
    fireEvent.change(screen.getByPlaceholderText("e.g., My Custom API"), { target: { value: "My Brevo" } });
    next();
    expect(await screen.findByText(/Authenticate with Brevo/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/xkeysib-/), { target: { value: "xkeysib-123" } });
    fireEvent.change(screen.getByPlaceholderText("noreply@yourdomain.com"), { target: { value: "hi@x.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: "My Brevo", type: "Brevo", credentials: expect.objectContaining({ apiKey: "xkeysib-123", provider: "brevo" }),
    }));
    expect(api.getCalendarStatus).not.toHaveBeenCalled();
  });

  it("a missing credential is still refused", async () => {
    const { onCreate } = setup();
    await chooseType(/SendGrid/);
    fireEvent.change(screen.getByPlaceholderText("e.g., My Custom API"), { target: { value: "SG" } });
    next();
    await screen.findByText(/Authenticate with SendGrid/);
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/required/));
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("Add Integration — Twilio", () => {
  const createCred = api.createTwilioCredential as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createCred.mockResolvedValue({ data: { id: "cred-1" }, error: null });
  });

  it("is offered in the type list", async () => {
    setup();
    const trigger = screen.getByRole("combobox", { name: "Integration type" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Twilio" })).toBeInTheDocument();
  });

  it("saves via the dedicated BYOT endpoint, not the generic integrations endpoint", async () => {
    const { onCreate, onTwilioConnected } = setup();
    await chooseType("Twilio");
    fireEvent.change(screen.getByPlaceholderText("e.g., My Custom API"), { target: { value: "Main Twilio" } });
    next();
    fireEvent.change(await screen.findByPlaceholderText(/ACxxxx/), { target: { value: "ACreal123" } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "secrettoken" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));

    await waitFor(() => expect(createCred).toHaveBeenCalledWith({
      account_sid: "ACreal123", auth_token: "secrettoken", label: "Main Twilio",
    }));
    await waitFor(() => expect(onTwilioConnected).toHaveBeenCalled());
    expect(onCreate).not.toHaveBeenCalled(); // never goes through the generic path
    expect(await screen.findByText(/Integration Created Successfully/)).toBeInTheDocument();
  });

  it("a missing field is refused before calling the API", async () => {
    setup();
    await chooseType("Twilio");
    fireEvent.change(screen.getByPlaceholderText("e.g., My Custom API"), { target: { value: "Main Twilio" } });
    next();
    await screen.findByPlaceholderText(/ACxxxx/);
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/required/));
    expect(createCred).not.toHaveBeenCalled();
  });

  it("a backend rejection keeps the dialog on the credentials step", async () => {
    createCred.mockResolvedValue({ data: null, error: "Twilio rejected these credentials" });
    setup();
    await chooseType("Twilio");
    fireEvent.change(screen.getByPlaceholderText("e.g., My Custom API"), { target: { value: "Main Twilio" } });
    next();
    fireEvent.change(await screen.findByPlaceholderText(/ACxxxx/), { target: { value: "ACbad" } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Twilio rejected these credentials"));
    expect(screen.getByPlaceholderText(/ACxxxx/)).toBeInTheDocument(); // still on step 2
  });

  it("the button shows a connecting state while the request is in flight", async () => {
    let resolve: (v: any) => void;
    createCred.mockReturnValue(new Promise((r) => { resolve = r; }));
    setup();
    await chooseType("Twilio");
    fireEvent.change(screen.getByPlaceholderText("e.g., My Custom API"), { target: { value: "Main Twilio" } });
    next();
    fireEvent.change(await screen.findByPlaceholderText(/ACxxxx/), { target: { value: "ACreal" } });
    fireEvent.change(screen.getByPlaceholderText("Your Twilio Auth Token"), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Connecting/ })).toBeDisabled());
    resolve!({ data: { id: "cred-1" }, error: null });
  });
});
