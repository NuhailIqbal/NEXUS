import { choose, pick } from "@/test/pick";
import "@/test/radix-stubs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vi as viConfig } from "vitest";
viConfig.setConfig({ testTimeout: 20000 });   // the 96-slot time list and the zone list render slowly in jsdom when the machine is busy
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getCampaigns: vi.fn(), getAgents: vi.fn(), getPhoneNumbers: vi.fn(), getAnalyticsOverview: vi.fn(), getContacts: vi.fn(),
    getLists: vi.fn(), getDncStatus: vi.fn(), getDialingLimits: vi.fn(), getCampaignsLive: vi.fn(),
    createCampaign: vi.fn(), updateCampaign: vi.fn(), deleteCampaign: vi.fn(),
    startCampaign: vi.fn(), pauseCampaign: vi.fn(), resumeCampaign: vi.fn(), getCampaignNumbers: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Outbound from "./Outbound";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const OPEN_STATE = { enabled: true, open: true, next_open_at: null, summary: "Mon–Fri, 9:00 AM–5:00 PM (Asia/Karachi)" };
const CLOSED_STATE = { enabled: true, open: false, next_open_at: "2026-10-13T04:00:00Z", summary: "Mon–Fri, 9:00 AM–5:00 PM (Asia/Karachi)" };

const campaign = (over: Record<string, unknown> = {}) => ({
  id: "c1", name: "Spring Push", status: "Inactive", agent_id: "a1", list_id: "l1", phone_number_id: "p1",
  contacts_count: 10, completed_count: 0,
  call_hours_enabled: false, call_hours_timezone: "Asia/Karachi", call_hours_days: [0, 1, 2, 3, 4],
  call_hours_start: "09:00", call_hours_end: "17:00", call_hours_state: { enabled: false, open: true, next_open_at: null, summary: null },
  dial_cursor: null,
  ...over,
});
const withHours = (state: object, over: Record<string, unknown> = {}) =>
  campaign({ call_hours_enabled: true, call_hours_state: state, ...over });

function mock(campaigns: object[]) {
  fn(api.getCampaigns).mockResolvedValue({ data: campaigns, error: null });
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara", vapi_assistant_id: "asst" }], error: null });
  fn(api.getPhoneNumbers).mockResolvedValue({ data: [{ id: "p1", number: "+15550001111", vapi_phone_id: "vp1" }], error: null });
  fn(api.getAnalyticsOverview).mockResolvedValue({ data: { qualified_calls: 0 }, error: null });
  fn(api.getContacts).mockResolvedValue({ data: [{ id: "k1", list_id: "l1", phone: "+15550002222" }], error: null });
  fn(api.getLists).mockResolvedValue({ data: [], error: null });
  fn(api.getDncStatus).mockResolvedValue({ data: { enabled: false, integration_id: null }, error: null });
  fn(api.updateCampaign).mockResolvedValue({ data: {}, error: null });
  fn(api.getDialingLimits).mockResolvedValue({ data: { account_limit: null, source: null, platform_limit: null }, error: null });
  fn(api.getCampaignsLive).mockResolvedValue({ data: {}, error: null });
  fn(api.startCampaign).mockResolvedValue({
    data: { started: true, resumed: false, already_running: false, strategy: "sequential", dialed: 5, placed: 5, queued: 5, active_now: 1, errors: 0, suppressed: 0 },
    warnings: [], error: null,
  });
  fn(api.resumeCampaign).mockResolvedValue({
    data: { started: false, resumed: true, already_running: false, strategy: "sequential", dialed: 3, placed: 3, queued: 6, active_now: 1, errors: 0, suppressed: 0 },
    warnings: [], error: null,
  });
}

const cardOf = (name: string) => screen.getByText(name).closest("div.rounded-xl") as HTMLElement;
const startFrom = (card: HTMLElement) => fireEvent.click(within(card).getByRole("button", { name: /Start/ }));
const launchButton = () => screen.getByRole("button", { name: /Launch Campaign/ });

beforeEach(() => vi.clearAllMocks());

describe("Outbound campaigns: calling hours on the card", () => {
  it("a campaign without hours shows no hours line", async () => {
    mock([campaign()]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(screen.queryByText(/Open now/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Closed/)).not.toBeInTheDocument();
  });

  it("shows the hours in words and that it is open now", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    const card = cardOf("Spring Push");
    expect(card).toHaveTextContent("Mon–Fri, 9:00 AM–5:00 PM (Asia/Karachi)");
    expect(within(card).getByText("Open now")).toBeInTheDocument();
  });

  it("shows when a closed campaign opens next, in its own timezone", async () => {
    mock([withHours(CLOSED_STATE)]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).toHaveTextContent(/Closed — opens Tue, Oct 13, 9:00 AM/);
  });

  it("a campaign stopped partway says Start carries on", async () => {
    mock([withHours(OPEN_STATE, { status: "Paused", dial_cursor: "k5" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).toHaveTextContent(/Stopped partway/);
  });
});

describe("Outbound campaigns: a completed campaign", () => {
  const COMPLETED = { contacts_count: 10, completed_count: 10 };

  it.each(["Active", "Paused", "Inactive"])("has no Pause or Start button (underlying status %s)", async (status) => {
    mock([campaign({ ...COMPLETED, status })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    const card = cardOf("Spring Push");
    expect(within(card).queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Start/ })).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /All contacts reached/ })).toBeDisabled();
  });

  it("Pause and Start stay available until every contact has a completed call", async () => {
    mock([
      campaign({ id: "c1", name: "Running", status: "Active", contacts_count: 10, completed_count: 9 }),
      campaign({ id: "c2", name: "Waiting", status: "Paused", contacts_count: 10, completed_count: 9 }),
      campaign({ id: "c3", name: "Fresh", status: "Inactive", contacts_count: 10, completed_count: 0 }),
    ]);
    render(<Outbound />);
    await screen.findByText("Running");
    expect(within(cardOf("Running")).getByRole("button", { name: /Pause/ })).toBeEnabled();
    expect(within(cardOf("Waiting")).getByRole("button", { name: /Start/ })).toBeEnabled();
    expect(within(cardOf("Fresh")).getByRole("button", { name: /Start/ })).toBeEnabled();
    expect(screen.queryByText(/All contacts reached/)).not.toBeInTheDocument();
  });

  it("an empty list is not 'completed'", async () => {
    mock([campaign({ status: "Inactive", contacts_count: 0, completed_count: 0 })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(within(cardOf("Spring Push")).getByRole("button", { name: /Start/ })).toBeEnabled();
  });

  it("goes back to Pause/Start once new contacts are added to the list", async () => {
    mock([campaign({ ...COMPLETED, status: "Active" })]);
    const { unmount } = render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(screen.getByText(/All contacts reached/)).toBeInTheDocument();
    unmount();
    mock([campaign({ contacts_count: 15, completed_count: 10, status: "Active" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(within(cardOf("Spring Push")).getByRole("button", { name: /Pause/ })).toBeEnabled();
  });
});

describe("Outbound campaigns: starting", () => {
  it("while closed the pre-launch check fails with when it opens, and Launch stays disabled", async () => {
    mock([withHours(CLOSED_STATE)]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("Contact list has dialable contacts").closest("div.flex")).toHaveTextContent(/ready to dial/));
    expect(within(dialog).getByText("Inside calling hours")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/Closed right now, opens Tue, Oct 13, 9:00 AM/);
    expect(launchButton()).toBeDisabled();
    expect(api.startCampaign).not.toHaveBeenCalled();
  });

  it("while open the check passes and the campaign launches", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent("Inside calling hours");
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.startCampaign).toHaveBeenCalledWith("c1"));
    expect(toast.success).toHaveBeenCalledWith("Campaign started: 5 calls placed, 5 numbers queued (one at a time)");
  });

  it("without hours there is nothing to wait for", async () => {
    mock([campaign()]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent("No calling-hours limit");
  });

  it("when the hours end mid-run it says how far it got and when to start again", async () => {
    mock([withHours(OPEN_STATE)]);
    fn(api.startCampaign).mockResolvedValue({
      data: { dialed: 4, errors: 0, suppressed: 0, stopped_by_hours: true, remaining: 6, next_open_at: "2026-10-13T04:00:00Z" },
      error: null,
    });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const message = fn(toast.warning).mock.calls[0][0] as string;
    expect(message).toMatch(/Calling hours ended: 4 called, 6 contacts left/);
    expect(message).toMatch(/continue automatically/);
    expect(message).not.toMatch(/Start the campaign again/);
    expect(message).toMatch(/Tue, Oct 13, 9:00 AM/);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a campaign Paused part-way through a run is continued with resume", async () => {
    mock([withHours(OPEN_STATE, { status: "Paused", dial_cursor: "k5", dial_running: true })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.resumeCampaign).toHaveBeenCalledWith("c1"));
    expect(api.startCampaign).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Campaign resumed: 3 calls placed, 6 numbers queued (one at a time)");
  });

  it("the server's own view of an open run (dialing.running) also means resume", async () => {
    mock([withHours(OPEN_STATE, { status: "Paused", dialing: { settings: {}, running: true, stall_reason: null } })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.resumeCampaign).toHaveBeenCalledWith("c1"));
  });

  // Re-pinned: a Paused campaign with NO pass open (it had finished) used to be STARTED, which dials the whole list a
  // second time. It is resumed now: the server only makes it Active again and its redials go on.
  it("a Paused campaign with no run open is resumed, never started (the finished list is not dialed again)", async () => {
    mock([withHours(OPEN_STATE, { status: "Paused", dial_running: false })]);
    fn(api.resumeCampaign).mockResolvedValue({ data: { status: "Active" }, warnings: [], error: null });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.resumeCampaign).toHaveBeenCalledWith("c1"));
    expect(api.startCampaign).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Campaign resumed. Numbers waiting for a redial will go out as they come due.");
  });

  it("an Inactive campaign is started, and an Active one that is not running too", async () => {
    mock([withHours(OPEN_STATE, { status: "Inactive", dial_running: false })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.startCampaign).toHaveBeenCalledWith("c1"));
    expect(api.resumeCampaign).not.toHaveBeenCalled();
  });

  describe("what the start toast says", () => {
    const launch = async () => {
      render(<Outbound />);
      await screen.findByText("Spring Push");
      startFrom(cardOf("Spring Push"));
      await waitFor(() => expect(launchButton()).toBeEnabled());
      fireEvent.click(launchButton());
    };

    it("a Concurrent campaign names how many run at a time", async () => {
      mock([campaign({ dial_strategy: "concurrent", dial_concurrent_calls: 5 })]);
      fn(api.startCampaign).mockResolvedValue({ data: { started: true, strategy: "concurrent", dialed: 5, placed: 5, queued: 118, errors: 0, suppressed: 0 }, warnings: [], error: null });
      await launch();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Campaign started: 5 calls placed, 118 numbers queued (5 at a time)"));
    });

    it("the account's cap is what it says when the campaign asked for more", async () => {
      mock([campaign({ dial_strategy: "concurrent", dial_concurrent_calls: 10 })]);
      fn(api.startCampaign).mockResolvedValue({
        data: { started: true, strategy: "concurrent", placed: 3, queued: 40, errors: 0, suppressed: 0, capped: { requested: 10, effective: 3, reason: "account" } },
        warnings: ["Concurrent Calls is set to 10, but your account allows 3 calls at the same time. Calls will run 3 at a time."], error: null,
      });
      await launch();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Campaign started: 3 calls placed, 40 numbers queued (3 at a time)"));
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/your account allows 3 calls at the same time/));
    });

    it("a Paced campaign names its rate, and one number is singular", async () => {
      mock([campaign({ dial_strategy: "paced", dial_calls_per_minute: 10 })]);
      fn(api.startCampaign).mockResolvedValue({ data: { started: true, strategy: "paced", placed: 1, queued: 1, errors: 0, suppressed: 0 }, warnings: [], error: null });
      await launch();
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Campaign started: 1 call placed, 1 number queued (10 per minute)"));
    });

    it("every warning the server sends is its own toast", async () => {
      mock([campaign()]);
      fn(api.startCampaign).mockResolvedValue({ data: { started: true, strategy: "sequential", placed: 1, queued: 0, errors: 0, suppressed: 0 }, warnings: ["First warning.", "Second warning."], error: null });
      await launch();
      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("First warning."));
      expect(toast.warning).toHaveBeenCalledWith("Second warning.");
    });

    it("already running is an info toast, not an error, and changes nothing", async () => {
      mock([campaign()]);
      fn(api.startCampaign).mockResolvedValue({ data: { started: false, already_running: true, strategy: "sequential", placed: 0, dialed: 0 }, warnings: [], error: null });
      await launch();
      await waitFor(() => expect(toast.info).toHaveBeenCalledWith("This campaign is already running."));
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("no call placed and errors: the first error is the toast", async () => {
      mock([campaign()]);
      fn(api.startCampaign).mockResolvedValue({
        data: { started: true, placed: 0, dialed: 0, queued: 9, errors: 2, error_details: [{ phone: "+1555", error: "Agent not found" }, { phone: "+1556", error: "x" }] },
        warnings: [], error: null,
      });
      await launch();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Agent not found")));
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("some calls placed and some errors is a warning with the failure count", async () => {
      mock([campaign()]);
      fn(api.startCampaign).mockResolvedValue({ data: { started: true, placed: 4, queued: 6, errors: 1 }, warnings: [], error: null });
      await launch();
      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith("Campaign started: 4 calls placed, 6 numbers queued (one at a time), 1 failed"));
    });

    it("a refusal from the server is shown as the error", async () => {
      mock([campaign()]);
      fn(api.startCampaign).mockResolvedValue({ data: null, error: "Dialing is being upgraded" });
      await launch();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Dialing is being upgraded"));
    });

    it("the server's error text never names the call service", async () => {
      mock([campaign()]);
      fn(api.startCampaign).mockResolvedValue({ data: { placed: 0, errors: 1, error_details: [{ phone: "+1", error: "Vapi said no" }] }, warnings: [], error: null });
      await launch();
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(fn(toast.error).mock.calls[0][0]).not.toMatch(/vapi/i);
    });
  });
});

describe("Outbound campaigns: hours in the settings", () => {
  // The settings are the same wizard as creating a campaign: step 3 is the Calling Hours.
  const openSettings = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Campaign Basics");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the campaign may call");
    await screen.findByRole("switch", { name: "Only call during set hours" });
    return dialog;
  };
  const hoursSwitch = () => screen.getByRole("switch", { name: "Only call during set hours" });

  it("opens with the stored hours", async () => {
    mock([withHours(OPEN_STATE, { call_hours_days: [0, 2], call_hours_start: "10:15", call_hours_end: "16:00" })]);
    render(<Outbound />);
    await openSettings();
    expect(hoursSwitch()).toBeChecked();
    expect(screen.getByLabelText("Calls start")).toHaveTextContent("10:15 AM");
    expect(screen.getByLabelText("Calls stop")).toHaveTextContent("4:00 PM");
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Tue" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
  });

  it("switching hours on and saving sends all five fields", async () => {
    mock([campaign()]);
    render(<Outbound />);
    await openSettings();
    expect(hoursSwitch()).not.toBeChecked();
    fireEvent.click(hoursSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(fn(api.updateCampaign).mock.calls[0][0]).toBe("c1");
    expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({
      name: "Spring Push", call_hours_enabled: true, call_hours_timezone: "Asia/Karachi",
      call_hours_days: [0, 1, 2, 3, 4], call_hours_start: "09:00", call_hours_end: "17:00",
    });
    expect(toast.success).toHaveBeenCalledWith("Campaign updated");
  });

  it("switching them off keeps the rest and sends enabled false", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({ call_hours_enabled: false, call_hours_start: "09:00" });
  });

  it("refuses hours with no day selected before anything is sent", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await openSettings();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(toast.error).toHaveBeenCalledWith("Pick at least one day.");
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    mock([campaign()]);
    fn(api.updateCampaign).mockResolvedValue({ data: null, error: "End time must be after start time." });
    render(<Outbound />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("End time must be after start time."));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("Outbound campaigns: creating one with hours", () => {
  async function createThroughWizard(switchHoursOn: boolean) {
    await screen.findByText("Spring Push");
    fireEvent.click(screen.getAllByRole("button", { name: /New Campaign/ })[0]);
    await screen.findByText("Campaign Information");
    fireEvent.click(screen.getAllByRole("combobox")[1]);                       // number
    // the page's campaign card shows the same number: the popover's entry is the last one in the page
    const numbers = await screen.findAllByText("+15550001111");
    fireEvent.click(numbers[numbers.length - 1]);
    fireEvent.change(screen.getByPlaceholderText(/Q3 Cold Outreach/), { target: { value: "Autumn" } });
    fireEvent.click(screen.getAllByRole("combobox")[0]);                       // agent
    fireEvent.click(await screen.findByRole("option", { name: "Sara" }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getAllByRole("combobox")[0]);                       // list
    fireEvent.click(await screen.findByRole("option", { name: /Leads/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the campaign may call");           // the hours step
    if (switchHoursOn) {
      fireEvent.click(screen.getByRole("switch", { name: "Only call during set hours" }));
      await pick("Timezone", "karachi");                                        // none is pre-selected
    }
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Call again when a number does not pick up");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Choose how the campaign places its calls");        // the dialing step
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Campaign Summary");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
  }

  it("sends the chosen hours with the new campaign", async () => {
    mock([campaign()]);
    fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
    fn(api.createCampaign).mockResolvedValue({ data: {}, error: null });
    render(<Outbound />);
    await createThroughWizard(true);
    await waitFor(() => expect(api.createCampaign).toHaveBeenCalled());
    expect(fn(api.createCampaign).mock.calls[0][0]).toMatchObject({
      name: "Autumn", agent_id: "a1", list_id: "l1", phone_number_id: "p1",
      call_hours_enabled: true, call_hours_timezone: "Asia/Karachi", call_hours_days: [0, 1, 2, 3, 4],
      call_hours_start: "09:00", call_hours_end: "17:00",
    });
  });

  it("a campaign created without touching the hours is created with them off", async () => {
    mock([campaign()]);
    fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
    fn(api.createCampaign).mockResolvedValue({ data: {}, error: null });
    render(<Outbound />);
    await createThroughWizard(false);
    await waitFor(() => expect(api.createCampaign).toHaveBeenCalled());
    expect(fn(api.createCampaign).mock.calls[0][0]).toMatchObject({ call_hours_enabled: false });
  });
});

describe("Outbound campaigns: no time zone is pre-selected", () => {
  // A campaign nobody configured holds the server's untouched "UTC"; it must not look chosen.
  const untouched = () => campaign({ call_hours_timezone: "UTC" });
  // The settings are the same wizard as creating a campaign: step 3 is the Calling Hours.
  const openSettings = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Campaign Basics");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the campaign may call");
    await screen.findByRole("switch", { name: "Only call during set hours" });
    return dialog;
  };
  const hoursSwitch = () => screen.getByRole("switch", { name: "Only call during set hours" });
  const saveButton = () => screen.getByRole("button", { name: "Save Changes" });

  it("the time zone starts on its placeholder, whatever the browser's zone is", async () => {
    mock([untouched()]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
    expect(screen.getByLabelText("Timezone")).not.toHaveTextContent(/Pakistan|UTC/);
  });

  it("switching the hours on without choosing one is refused before anything is sent", async () => {
    mock([untouched()]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    fireEvent.click(saveButton());
    expect(toast.error).toHaveBeenCalledWith("Select a time zone.");
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("once the user chooses a time zone it is what gets saved", async () => {
    mock([untouched()]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(hoursSwitch());
    await pick("Timezone", "karachi");
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({ call_hours_enabled: true, call_hours_timezone: "Asia/Karachi" });
  });

  it("saving other changes with the hours left off sends no time zone, so nothing is stored", async () => {
    mock([untouched()]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(saveButton());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    const sent = fn(api.updateCampaign).mock.calls[0][1];
    expect(sent).toMatchObject({ call_hours_enabled: false, name: "Spring Push" });
    expect(sent).not.toHaveProperty("call_hours_timezone");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a campaign that already has a time zone saved keeps showing it", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await openSettings();
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
  });
});

describe("Outbound campaigns: continuing by itself", () => {
  const waiting = (over: Record<string, unknown> = {}) =>
    withHours(CLOSED_STATE, { status: "Paused", dial_cursor: "k5", auto_resume: { pending: true, next_at: "2026-10-13T04:00:00Z" }, ...over });
  const note = () => cardOf("Spring Push").textContent ?? "";

  it("a stopped campaign says it continues automatically, and when (in its own zone)", async () => {
    mock([waiting()]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(note()).toMatch(/continues automatically with the contacts that are left when the hours open \(Tue, Oct 13, 9:00 AM/);
    expect(note()).not.toMatch(/Start continues/);
  });

  it("when the hours are open already it says within a minute", async () => {
    mock([waiting({ auto_resume: { pending: true, next_at: null }, call_hours_state: OPEN_STATE })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(note()).toMatch(/within a minute/);
  });

  it("a stopped campaign that is NOT waiting (a person paused it) still says Start continues", async () => {
    mock([waiting({ auto_resume: { pending: false, next_at: null } })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(note()).toMatch(/Start continues with the contacts that are left/);
    expect(within(cardOf("Spring Push")).queryByRole("button", { name: "Stop auto-resume" })).not.toBeInTheDocument();
  });

  it("a campaign that is not stopped shows nothing about it", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(note()).not.toMatch(/automatically|Stopped partway/);
  });

  it("Stop auto-resume pauses it (which cancels the continuing), tells the user and reloads", async () => {
    mock([waiting()]);
    fn(api.pauseCampaign).mockResolvedValue({ data: { status: "Paused" }, error: null });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    const before = fn(api.getCampaigns).mock.calls.length;
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Stop auto-resume" }));
    await waitFor(() => expect(api.pauseCampaign).toHaveBeenCalledWith("c1"));
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/Automatic continuing stopped/));
    await waitFor(() => expect(fn(api.getCampaigns).mock.calls.length).toBeGreaterThan(before));
  });

  it("a refusal is shown and nothing is reloaded as if it worked", async () => {
    mock([waiting()]);
    fn(api.pauseCampaign).mockResolvedValue({ data: null, error: "Could not pause" });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Stop auto-resume" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not pause"));
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("Outbound campaigns: a person's Pause while it runs, and a running campaign", () => {
  it("a run stopped by a Pause says how far it got, and that Start carries on", async () => {
    mock([withHours(OPEN_STATE)]);
    fn(api.startCampaign).mockResolvedValue({ data: { dialed: 4, errors: 0, suppressed: 0, stopped_by_person: true, remaining: 6 }, error: null });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(fn(toast.info).mock.calls[0][0]).toMatch(/Stopped: 4 called, 6 contacts left\. Start carries on from the next contact/);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("a campaign that is running right now does not claim to have stopped partway", async () => {
    mock([withHours(OPEN_STATE, { status: "Active", dial_cursor: "k5" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push").textContent).not.toMatch(/Stopped partway/);
    expect(within(cardOf("Spring Push")).getByRole("button", { name: /Pause/ })).toBeInTheDocument();
  });
});

describe("Outbound campaigns: breaks and a custom schedule in the settings", () => {
  // The settings are the same wizard as creating a campaign: step 3 is the Calling Hours.
  const openSettings = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Campaign Basics");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the campaign may call");
    await screen.findByRole("switch", { name: "Only call during set hours" });
    return dialog;
  };
  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
  const sentSchedule = () => (fn(api.updateCampaign).mock.calls[0][1] as Record<string, unknown>).call_hours_schedule;
  const lunch = { start: "13:00", end: "14:00" };

  it("opens with the stored breaks", async () => {
    mock([withHours(OPEN_STATE, { call_hours_schedule: { mode: "same", breaks: [lunch] } })]);
    render(<Outbound />);
    await openSettings();
    expect(screen.getByRole("radio", { name: "Same schedule every day" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Break 1 start")).toHaveTextContent("1:00 PM");
    expect(screen.getByLabelText("Break 1 end")).toHaveTextContent("2:00 PM");
  });

  it("opens with a stored custom schedule: its days on, with their own hours and breaks", async () => {
    mock([withHours(OPEN_STATE, { call_hours_schedule: { mode: "per_day", days: {
      "0": { on: true, start: "09:00", end: "18:00", breaks: [lunch] }, "5": { on: true, start: "10:00", end: "14:00", breaks: [] },
    } } })]);
    render(<Outbound />);
    await openSettings();
    expect(screen.getByRole("radio", { name: "Custom schedule per day" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Monday" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Tuesday" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Saturday" })).toBeChecked();
    expect(screen.getByLabelText("Monday end")).toHaveTextContent("6:00 PM");
    expect(screen.getByLabelText("Saturday start")).toHaveTextContent("10:00 AM");
    expect(screen.getByLabelText("Monday break 1 start")).toHaveTextContent("1:00 PM");
  });

  it("adding a break and saving sends it with the schedule", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Add break" }));
    save();
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(sentSchedule()).toEqual({ mode: "same", breaks: [lunch] });
    expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({ call_hours_days: [0, 1, 2, 3, 4], call_hours_start: "09:00", call_hours_end: "17:00" });
  });

  it("saving without touching the schedule sends it unchanged", async () => {
    mock([withHours(OPEN_STATE, { call_hours_schedule: { mode: "same", breaks: [lunch] } })]);
    render(<Outbound />);
    await openSettings();
    save();
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(sentSchedule()).toEqual({ mode: "same", breaks: [lunch] });
  });

  it("a custom schedule is saved day by day, with off days sent as off", async () => {
    mock([withHours(OPEN_STATE)]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(screen.getByRole("radio", { name: "Custom schedule per day" }));
    await choose("Friday end", "1:00 PM");
    fireEvent.click(screen.getByRole("switch", { name: "Tuesday" }));
    save();
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    const sent = sentSchedule() as { mode: string; days: Record<string, unknown> };
    expect(sent.mode).toBe("per_day");
    expect(sent.days["0"]).toEqual({ on: true, start: "09:00", end: "17:00", breaks: [] });
    expect(sent.days["1"]).toEqual({ on: false });
    expect(sent.days["4"]).toEqual({ on: true, start: "09:00", end: "13:00", breaks: [] });
    expect(sent.days["5"]).toEqual({ on: false });
  });

  it("a problem is refused before anything is sent, with the reason", async () => {
    mock([withHours(OPEN_STATE, { call_hours_schedule: { mode: "same", breaks: [{ start: "07:00", end: "08:00" }] } })]);
    render(<Outbound />);
    await openSettings();
    expect(screen.getByRole("alert")).toHaveTextContent("A break must fall inside the running hours (9:00 AM–5:00 PM).");
    save();
    expect(toast.error).toHaveBeenCalledWith("A break must fall inside the running hours (9:00 AM–5:00 PM).");
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("the server's refusal of a schedule is shown and the dialog stays open", async () => {
    mock([withHours(OPEN_STATE)]);
    fn(api.updateCampaign).mockResolvedValue({ data: null, error: "Breaks can't overlap." });
    render(<Outbound />);
    await openSettings();
    save();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Breaks can't overlap."));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("the card says the hours with their breaks (the server's words)", async () => {
    mock([withHours({ ...OPEN_STATE, summary: "Mon–Fri, 9:00 AM–6:00 PM, break 1:00 PM–2:00 PM (Asia/Karachi)" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).toHaveTextContent("break 1:00 PM–2:00 PM");
  });

  it("during a break the card is closed and says when it opens again", async () => {
    mock([withHours({ enabled: true, open: false, next_open_at: "2026-10-13T09:00:00Z", summary: "Mon–Fri, 9:00 AM–6:00 PM, break 1:00 PM–2:00 PM (Asia/Karachi)" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).toHaveTextContent(/Closed — opens Tue, Oct 13, 2:00 PM/);
  });

  it("a new campaign made in the wizard carries its schedule", async () => {
    mock([campaign()]);
    fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
    fn(api.createCampaign).mockResolvedValue({ data: {}, error: null });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    fireEvent.click(screen.getAllByRole("button", { name: /New Campaign/ })[0]);
    await screen.findByText("Campaign Information");
    fireEvent.click(screen.getAllByRole("combobox")[1]);
    const numbers = await screen.findAllByText("+15550001111");
    fireEvent.click(numbers[numbers.length - 1]);
    fireEvent.change(screen.getByPlaceholderText(/Q3 Cold Outreach/), { target: { value: "Autumn" } });
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Sara" }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getAllByRole("combobox")[0]);
    fireEvent.click(await screen.findByRole("option", { name: /Leads/ }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Days and times the campaign may call");
    fireEvent.click(screen.getByRole("switch", { name: "Only call during set hours" }));
    await pick("Timezone", "karachi");
    fireEvent.click(screen.getByRole("button", { name: "Add break" }));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Call again when a number does not pick up");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Choose how the campaign places its calls");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Campaign Summary");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    await waitFor(() => expect(api.createCampaign).toHaveBeenCalled());
    expect(fn(api.createCampaign).mock.calls[0][0]).toMatchObject({
      call_hours_schedule: { mode: "same", breaks: [{ start: "13:00", end: "14:00" }] },
    });
  });
});

describe("Outbound campaigns: auto redial", () => {
  const STATS = { total_attempts: 12, retries_placed: 5, answered_on_retry: 3, max_attempts_reached: 2, pending_retries: 4, numbers: 7 };
  const retryCampaign = (over: Record<string, unknown> = {}) => campaign({
    retry_enabled: true, retry_max_attempts: 3, retry_interval_minutes: 10, retry_on: ["no_answer", "busy"],
    retry_stats: STATS, status: "Active", ...over,
  });
  // The settings are the same wizard as creating a campaign: step 4 is the Auto Redial.
  const openSettings = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog");
    await screen.findByText("Campaign Basics");
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    await screen.findByText("Call again when a number does not pick up");
    await screen.findByRole("switch", { name: "Enable auto redial" });
    return dialog;
  };
  const retrySwitch = () => screen.getByRole("switch", { name: "Enable auto redial" });

  it("a campaign without retry shows no retry line and no counts", async () => {
    mock([campaign({ retry_enabled: false, retry_stats: { ...STATS, total_attempts: 0, pending_retries: 0 } })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).not.toHaveTextContent(/Retry:/);
    expect(within(cardOf("Spring Push")).queryByLabelText("Call attempts")).not.toBeInTheDocument();
    expect(within(cardOf("Spring Push")).queryByRole("button", { name: /Numbers/ })).not.toBeInTheDocument();
  });

  it("the card shows the settings, the waiting retries and the four counts", async () => {
    mock([retryCampaign()]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    const card = cardOf("Spring Push");
    expect(card).toHaveTextContent("Auto redial");
    expect(card).toHaveTextContent("Up to 3 calls · every 10 min");
    expect(card).toHaveTextContent("Redials on: no answer, busy");
    expect(card).toHaveTextContent("4 waiting");
    const counts = within(card).getByLabelText("Call attempts");
    expect(counts).toHaveTextContent(/12\s*Attempts/);
    expect(counts).toHaveTextContent(/5\s*Redials/);
    expect(counts).toHaveTextContent(/3\s*Answered on redial/);
    expect(counts).toHaveTextContent(/2\s*Max attempts/);
  });

  it("does not list the outcomes when every one is ticked", async () => {
    mock([retryCampaign({ retry_on: ["no_answer", "busy", "voicemail", "failed"] })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).toHaveTextContent("Up to 3 calls · every 10 min");
    expect(cardOf("Spring Push")).not.toHaveTextContent(/Retries on:/);
  });

  it("shows the counts of a campaign that has retry switched off but has placed calls, without the retry header", async () => {
    mock([campaign({ retry_enabled: false, retry_stats: STATS })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    const card = cardOf("Spring Push");
    expect(within(card).getByLabelText("Call attempts")).toHaveTextContent(/12\s*Attempts/);
    expect(card).not.toHaveTextContent("Auto redial");
  });

  it("says the waiting retries are on hold while the campaign is paused", async () => {
    mock([retryCampaign({ status: "Paused" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    expect(cardOf("Spring Push")).toHaveTextContent("4 waiting (campaign paused)");
  });

  it("the Numbers button opens the lead/number view of that campaign", async () => {
    mock([retryCampaign()]);
    fn(api.getCampaignNumbers).mockResolvedValue({
      data: { rows: [{ id: "n1", contact_id: "k1", name: "Ada", phone: "+15550002222", attempts: 2, round: 1, max_attempts: 3,
        last_outcome: "busy", last_attempt_at: "2026-10-14T12:00:00Z", next_attempt_at: "2026-10-14T12:10:00Z",
        final_status: null, status: "retry_scheduled", history: [] }], total: 1, retry: { enabled: true, max_attempts: 3, interval_minutes: 10 } },
      error: null,
    });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: /Numbers/ }));
    expect(await screen.findByText("+15550002222")).toBeInTheDocument();
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    expect(api.getCampaignNumbers).toHaveBeenCalledWith("c1", { status: "all", limit: 100, offset: 0 });
  });

  it("the settings open with the stored retry settings", async () => {
    mock([retryCampaign({ retry_max_attempts: 6, retry_interval_minutes: 25, retry_on: ["voicemail"] })]);
    render(<Outbound />);
    await openSettings();
    expect(retrySwitch()).toBeChecked();
    expect(screen.getByLabelText("Calls per number")).toHaveTextContent("6 calls");
    expect(screen.getByLabelText("Wait between calls")).toHaveTextContent("25 minutes");
    expect(screen.getByRole("checkbox", { name: "Voicemail / Answering Machine" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Busy" })).not.toBeChecked();
    expect(screen.getByText(/not to calls already in progress/)).toBeInTheDocument();
  });

  it("changing the settings and saving sends all four retry fields", async () => {
    mock([retryCampaign()]);
    render(<Outbound />);
    await openSettings();
    await choose("Calls per number", "8 calls");
    await choose("Wait between calls", "20 minutes");
    fireEvent.click(screen.getByRole("checkbox", { name: "Call Failed / Network Error" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({
      retry_enabled: true, retry_max_attempts: 8, retry_interval_minutes: 20, retry_on: ["no_answer", "busy", "failed"],
    });
  });

  it("switching retry on for a campaign that had it off, and saving, sends it", async () => {
    mock([campaign()]);
    render(<Outbound />);
    await openSettings();
    expect(retrySwitch()).not.toBeChecked();
    fireEvent.click(retrySwitch());
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({ retry_enabled: true, retry_max_attempts: 3, retry_interval_minutes: 10 });
  });

  it("will not save retry with nothing to retry on", async () => {
    mock([retryCampaign({ retry_on: ["busy"] })]);
    render(<Outbound />);
    await openSettings();
    fireEvent.click(screen.getByRole("checkbox", { name: "Busy" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(toast.error).toHaveBeenCalledWith("Choose at least one outcome to redial on.");
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("the launch toast mentions numbers skipped because they were already on a call", async () => {
    mock([campaign()]);
    fn(api.startCampaign).mockResolvedValue({ data: { dialed: 9, errors: 0, suppressed: 0, already_on_call: 1 }, error: null });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).not.toBeDisabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("1 skipped (already on a call)")));
  });
});

describe("Outbound campaigns: the edit wizard", () => {
  // The settings open the same six-step wizard as creating a campaign, starting from the campaign.
  const full = (over: Record<string, unknown> = {}) => campaign({
    status: "Paused", list_id: "l1", phone_number_id: "p1", dnc_screening_enabled: true,
    retry_enabled: true, retry_max_attempts: 4, retry_interval_minutes: 15, retry_on: ["busy", "failed"],
    dial_strategy: "concurrent", dial_concurrent_calls: 7, dial_calls_per_minute: 20, dial_delay_seconds: 2, ...over,
  });
  const openEdit = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    await screen.findByText("Campaign Basics");
  };
  const nextBtn = () => fireEvent.click(screen.getByRole("button", { name: /Next/ }));
  const saveBtn = () => screen.getByRole("button", { name: /Save Changes/ });
  const withLists = () => {
    mock([full()]);
    fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
  };

  it("is the creation wizard in edit mode: six steps, starting from the campaign", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 6/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Spring Push")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toHaveTextContent("Paused");
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
    // comboboxes on step 1, top to bottom: Status, Agent, From Number
    await waitFor(() => expect(screen.getAllByRole("combobox")[2]).toHaveTextContent("+15550001111"));
    expect(screen.getAllByRole("combobox")[1]).toHaveTextContent("Sara");
  });

  it("every step shows the campaign's stored values", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    nextBtn();
    await waitFor(() => expect(screen.getAllByRole("combobox")[0]).toHaveTextContent("Leads (4 contacts)"));
    nextBtn();
    await screen.findByText("Days and times the campaign may call");
    nextBtn();
    await screen.findByText("Call again when a number does not pick up");
    expect(screen.getByRole("switch", { name: "Enable auto redial" })).toBeChecked();
    expect(screen.getByLabelText("Calls per number")).toHaveTextContent("4 calls");
    expect(screen.getByLabelText("Wait between calls")).toHaveTextContent("15 minutes");
    expect(screen.getByRole("checkbox", { name: "Busy" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "No Answer" })).not.toBeChecked();
    nextBtn();
    await screen.findByText("Choose how the campaign places its calls");
    expect(screen.getByRole("radio", { name: "Concurrent" })).toBeChecked();
    expect(screen.getByLabelText("Concurrent Calls")).toHaveValue(7);
    expect(screen.getByLabelText("Delay between calls (seconds)")).toHaveValue(2);
    expect(screen.getByText(/not to calls already in progress/)).toBeInTheDocument();
    nextBtn();
    expect(await screen.findByText("Review & Save")).toBeInTheDocument();
    expect(screen.getByText("Concurrent: up to 7 calls at a time, 2 s between calls")).toBeInTheDocument();
    expect(screen.getByText("Confirm your changes")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText("Paused")).toBeInTheDocument();   // the Status tile
    expect(screen.getByText(/Up to 4 calls per number, 15 min apart, on busy, call failed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Launch Campaign/ })).not.toBeInTheDocument();
  });

  it("saves from the very first step, sending everything the wizard shows", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Spring Push"), { target: { value: "Summer Push" } });
    await choose("Status", "Active");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    const [id, body] = fn(api.updateCampaign).mock.calls[0];
    expect(id).toBe("c1");
    expect(body).toMatchObject({
      name: "Summer Push", status: "Active", agent_id: "a1", list_id: "l1", phone_number_id: "p1", dnc_screening_enabled: true,
      call_hours_enabled: false, retry_enabled: true, retry_max_attempts: 4, retry_interval_minutes: 15, retry_on: ["busy", "failed"],
      dial_strategy: "concurrent", dial_concurrent_calls: 7, dial_calls_per_minute: 20, dial_delay_seconds: 2,
    });
    expect(toast.success).toHaveBeenCalledWith("Campaign updated");
    await waitFor(() => expect(screen.queryByText("Campaign Basics")).not.toBeInTheDocument());
  });

  it("a status the person did not change is not sent (saving cannot un-pause a campaign paused elsewhere)", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Spring Push"), { target: { value: "Summer Push" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    const body = fn(api.updateCampaign).mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Summer Push", dial_strategy: "concurrent" });
    expect(body).not.toHaveProperty("status");
  });

  it("a status the person changed back to what it was is not sent either", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    await choose("Status", "Active");
    await choose("Status", "Paused");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    expect(fn(api.updateCampaign).mock.calls[0][1]).not.toHaveProperty("status");
  });

  it("saves from the last step too, with the same Save Changes button", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    for (let i = 0; i < 5; i++) nextBtn();
    await screen.findByText("Review & Save");
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalledTimes(1));
  });

  it("a name that is cleared is refused", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Spring Push"), { target: { value: "  " } });
    fireEvent.click(saveBtn());
    expect(toast.error).toHaveBeenCalledWith("Campaign name is required");
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("a problem on a later step is found from the first one: the wizard jumps there and says why", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    nextBtn(); nextBtn();
    await screen.findByText("Days and times the campaign may call");
    fireEvent.click(screen.getByRole("switch", { name: "Only call during set hours" }));
    await pick("Timezone", "karachi");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Campaign Basics");
    fireEvent.click(saveBtn());
    expect(toast.error).toHaveBeenCalledWith("Pick at least one day.");
    expect(await screen.findByText("Days and times the campaign may call")).toBeInTheDocument();
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("retry on with nothing ticked sends the wizard back to the retry step", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    for (let i = 0; i < 3; i++) nextBtn();
    await screen.findByText("Call again when a number does not pick up");
    fireEvent.click(screen.getByRole("checkbox", { name: "Busy" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Call Failed / Network Error" }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Campaign Basics");
    fireEvent.click(saveBtn());
    expect(toast.error).toHaveBeenCalledWith("Choose at least one outcome to redial on.");
    expect(await screen.findByText("Call again when a number does not pick up")).toBeInTheDocument();
    expect(api.updateCampaign).not.toHaveBeenCalled();
  });

  it("a refusal from the server keeps the wizard open with the reason, and nothing is announced as saved", async () => {
    withLists();
    fn(api.updateCampaign).mockResolvedValue({ data: null, error: "Select a time zone." });
    render(<Outbound />);
    await openEdit();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Select a time zone."));
    expect(screen.getByText("Campaign Basics")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalledWith("Campaign updated");
  });

  it("an unsaved edit is gone the next time it is opened, and it starts on the first step again", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    fireEvent.change(screen.getByDisplayValue("Spring Push"), { target: { value: "Changed" } });
    nextBtn();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    await waitFor(() => expect(screen.queryByText("Campaign Basics")).not.toBeInTheDocument());
    expect(api.updateCampaign).not.toHaveBeenCalled();
    await openEdit();
    expect(screen.getByDisplayValue("Spring Push")).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 6/)).toBeInTheDocument();
  });

  it("a campaign that never got a list or a number can still be saved; those are then left out of the update", async () => {
    mock([campaign({ list_id: null, phone_number_id: null })]);
    render(<Outbound />);
    await openEdit();
    fireEvent.click(saveBtn());
    await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
    const body = fn(api.updateCampaign).mock.calls[0][1] as Record<string, unknown>;
    expect(body).not.toHaveProperty("list_id");
    expect(body).not.toHaveProperty("phone_number_id");
    expect(body).toMatchObject({ name: "Spring Push", agent_id: "a1" });
  });

  it("the retry step says that changes apply to calls placed from now on", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    for (let i = 0; i < 3; i++) nextBtn();
    await screen.findByText("Call again when a number does not pick up");
    expect(screen.getByText(/not to calls already in progress/)).toBeInTheDocument();
  });
});

describe("Outbound campaigns: dialing strategy", () => {
  const liveOf = (over: Record<string, unknown> = {}) => ({
    campaign_id: "c1", state: "dialing", strategy: "concurrent", active_now: 5, queued: 118, queued_fresh: 118, queued_redials: 0,
    redials_due_now: 0, placed: 41, placed_last_minute: 10,
    counters: { suppressed: 0, busy: 0, duplicate: 0, errors: 0, last_error: null, last_error_at: null },
    stall_reason: null, next_call_at: null, pass_started_at: "2026-10-24T10:00:00Z", dispatcher_ok: true, as_of: "2026-10-24T10:05:00Z",
    ...over,
  });
  const liveMock = (state: object | null) =>
    fn(api.getCampaignsLive).mockResolvedValue({ data: state ? { c1: state } : {}, error: null });
  const running = (over: Record<string, unknown> = {}) =>
    campaign({ status: "Active", dial_strategy: "concurrent", dial_concurrent_calls: 5, dial_calls_per_minute: 10, dial_delay_seconds: 0, dial_running: true,
      dialing: { settings: { strategy: "concurrent", concurrent_calls: 5, calls_per_minute: 10, delay_seconds: 0 }, running: true, stall_reason: null }, ...over });
  const panel = (card: HTMLElement) => within(card).getByText("Dialing").closest("div.rounded-lg") as HTMLElement;

  describe("on the card", () => {
    it("shows the strategy in short form", async () => {
      mock([campaign({ dial_strategy: "concurrent", dial_concurrent_calls: 5, dial_delay_seconds: 2 })]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      expect(panel(cardOf("Spring Push"))).toHaveTextContent("Concurrent · 5 at a time · 2 s gap");
    });

    it("a row without any dial fields shows the defaults (Sequential)", async () => {
      mock([campaign()]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      expect(panel(cardOf("Spring Push"))).toHaveTextContent("Sequential · one at a time");
    });

    it("a Paced campaign shows its rate", async () => {
      mock([campaign({ dial_strategy: "paced", dial_calls_per_minute: 12 })]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      expect(panel(cardOf("Spring Push"))).toHaveTextContent("Paced · 12/min");
    });

    it("sits between the hours notes and the Auto redial panel", async () => {
      mock([withHours(OPEN_STATE, { retry_enabled: true, retry_stats: { total_attempts: 0, retries_placed: 0, answered_on_retry: 0, max_attempts_reached: 0, pending_retries: 0, numbers: 0 } })]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      const text = cardOf("Spring Push").textContent ?? "";
      expect(text.indexOf("Open now")).toBeGreaterThan(-1);
      expect(text.indexOf("Open now")).toBeLessThan(text.indexOf("Dialing"));
      expect(text.indexOf("Dialing")).toBeLessThan(text.indexOf("Auto redial"));
    });

    it("adds no button of its own", async () => {
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(within(cardOf("Spring Push")).getByLabelText("Live dialing")).toBeInTheDocument());
      expect(within(panel(cardOf("Spring Push"))).queryAllByRole("button")).toHaveLength(0);
    });

    it("never names the call service", async () => {
      mock([running()]);
      liveMock(liveOf({ stall_reason: "provider_limit", warnings: ["Calls will run 3 at a time."] }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(within(cardOf("Spring Push")).getByLabelText("Live dialing")).toBeInTheDocument());
      expect(cardOf("Spring Push").textContent).not.toMatch(/vapi|twilio|vonage|telnyx/i);
    });
  });

  describe("the live panel", () => {
    it("shows active now, in queue and placed for a running campaign", async () => {
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      const dl = await within(cardOf("Spring Push")).findByLabelText("Live dialing");
      expect(dl).toHaveTextContent(/5\s*Active now/);
      expect(dl).toHaveTextContent(/118\s*In queue/);
      expect(dl).toHaveTextContent(/41\s*Placed/);
      expect(cardOf("Spring Push")).toHaveTextContent("Dialing");
      expect(cardOf("Spring Push")).toHaveTextContent(/updated \d+ s ago/);
    });

    it("a Paced campaign also says when the next call goes out", async () => {
      mock([running({ dial_strategy: "paced", dial_calls_per_minute: 10 })]);
      liveMock(liveOf({ strategy: "paced", active_now: 2, next_call_at: "2026-10-24T10:05:04Z" }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await within(cardOf("Spring Push")).findByLabelText("Live dialing");
      expect(cardOf("Spring Push")).toHaveTextContent("Next call in 4 s");
    });

    it("a Sequential or Concurrent campaign has no next-call line", async () => {
      mock([running()]);
      liveMock(liveOf({ next_call_at: "2026-10-24T10:05:04Z" }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await within(cardOf("Spring Push")).findByLabelText("Live dialing");
      expect(cardOf("Spring Push")).not.toHaveTextContent(/Next call in/);
    });

    it("an idle campaign shows no live numbers", async () => {
      mock([running()]);
      liveMock(liveOf({ state: "idle", active_now: 0, queued: 0 }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
      expect(within(cardOf("Spring Push")).queryByLabelText("Live dialing")).not.toBeInTheDocument();
    });

    it("says why a campaign is waiting, in words", async () => {
      mock([running()]);
      liveMock(liveOf({ state: "stalled", active_now: 0, stall_reason: "balance" }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(cardOf("Spring Push")).toHaveTextContent(/Waiting for balance/));
    });

    it("shows the server's warning when the account's cap limits the campaign", async () => {
      mock([running()]);
      liveMock(liveOf({ warnings: ["Concurrent Calls is set to 5, but your account allows 3 calls at the same time. Calls will run 3 at a time."] }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(cardOf("Spring Push")).toHaveTextContent(/your account allows 3 calls at the same time/));
    });

    it("without a server warning, a capped campaign still says so", async () => {
      mock([running({ dialing: { settings: {}, running: true, stall_reason: null, effective: { concurrent_calls: 3, calls_per_minute: 10, capped: true, cap: 3, cap_source: "account" } } })]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      expect(cardOf("Spring Push")).toHaveTextContent("Limited to 3 calls at a time by your account.");
    });

    it("shows the last call error once there have been errors", async () => {
      mock([running()]);
      liveMock(liveOf({ counters: { errors: 2, last_error: "Number is not valid", last_error_at: "2026-10-24T10:04:00Z" } }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(cardOf("Spring Push")).toHaveTextContent("Last call error: Number is not valid"));
    });

    it("a finished campaign no longer shows the last call error", async () => {
      mock([running({ status: "Active", dial_running: false, dialing: { settings: {}, running: false, stall_reason: null } })]);
      liveMock(liveOf({ state: "idle", active_now: 0, queued: 0, counters: { errors: 2, last_error: "Number is not valid", last_error_at: "2026-10-24T10:04:00Z" } }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(cardOf("Spring Push")).not.toHaveTextContent(/Last call error/);
    });

    it("the last call error stays while calls are still open after the pass ended", async () => {
      mock([running({ dial_running: false, dialing: { settings: {}, running: false, stall_reason: null } })]);
      liveMock(liveOf({ state: "finishing", active_now: 2, counters: { errors: 1, last_error: "Number is not valid", last_error_at: null } }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(cardOf("Spring Push")).toHaveTextContent("Last call error: Number is not valid"));
    });

    it("does not pass on a provider's name in an error", async () => {
      mock([running()]);
      liveMock(liveOf({ counters: { errors: 1, last_error: "Vapi rejected the call", last_error_at: null } }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(cardOf("Spring Push")).toHaveTextContent(/Last call error/));
      expect(cardOf("Spring Push").textContent).not.toMatch(/vapi/i);
    });
  });

  describe("the live poll", () => {
    const hidden = () => Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    const visible = () => { delete (document as unknown as Record<string, unknown>).visibilityState; };

    afterEach(() => { vi.useRealTimers(); visible(); });

    it("reads once when the page loads and then every 4 seconds while a campaign has a pass open", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(4100);
      expect(api.getCampaignsLive).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4100);
      expect(api.getCampaignsLive).toHaveBeenCalledTimes(3);
    });

    it("does not keep polling when nothing is running (one read when the page loads, then none)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([campaign({ status: "Paused" }), campaign({ id: "c2", name: "Other", status: "Inactive" })]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await vi.advanceTimersByTimeAsync(9000);
      expect(api.getCampaignsLive).toHaveBeenCalledTimes(1);
    });

    it("a finished campaign (Active, no pass open, no calls) is not polled every 4 seconds", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([campaign({ status: "Active", dial_running: false, dialing: { settings: {}, running: false, stall_reason: null } })]);
      liveMock(liveOf({ state: "idle", active_now: 0, queued: 0 }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await vi.advanceTimersByTimeAsync(13000);
      expect(api.getCampaignsLive).toHaveBeenCalledTimes(1);
    });

    it("stops polling once the last call has ended and the pass is over", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await vi.advanceTimersByTimeAsync(4100);
      expect(api.getCampaignsLive).toHaveBeenCalledTimes(2);
      // the 30 s refresh finds the pass over
      mock([campaign({ status: "Active", dial_running: false, dialing: { settings: {}, running: false, stall_reason: null } })]);
      liveMock(liveOf({ state: "idle", active_now: 0, queued: 0 }));
      await vi.advanceTimersByTimeAsync(30100);
      const after = fn(api.getCampaignsLive).mock.calls.length;
      await vi.advanceTimersByTimeAsync(20000);
      expect(api.getCampaignsLive).toHaveBeenCalledTimes(after);
    });

    it("Pause reads the live numbers once more", async () => {
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
      fn(api.pauseCampaign).mockResolvedValue({ data: {}, error: null });
      fn(api.getCampaignsLive).mockClear();
      fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: /Pause/ }));
      await waitFor(() => expect(api.pauseCampaign).toHaveBeenCalledWith("c1"));
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
    });

    it("keeps polling a paused campaign that still has calls open", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([campaign({ status: "Paused", dial_running: true, dialing: { settings: {}, running: true, stall_reason: null } })]);
      liveMock(liveOf({ state: "finishing", active_now: 2 }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
      expect(await within(cardOf("Spring Push")).findByLabelText("Live dialing")).toHaveTextContent(/2\s*Active now/);
    });

    it("does not poll while the tab is hidden, and refreshes when it comes back", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      hidden();
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await vi.advanceTimersByTimeAsync(9000);
      expect(api.getCampaignsLive).not.toHaveBeenCalled();
      visible();
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalledTimes(1));
    });

    it("stops polling when the page goes away", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([running()]);
      liveMock(liveOf());
      const { unmount } = render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
      unmount();
      const before = fn(api.getCampaignsLive).mock.calls.length;
      await vi.advanceTimersByTimeAsync(9000);
      expect(fn(api.getCampaignsLive).mock.calls.length).toBe(before);
    });

    it("a failed poll keeps what was shown", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mock([running()]);
      liveMock(liveOf());
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await within(cardOf("Spring Push")).findByLabelText("Live dialing");
      fn(api.getCampaignsLive).mockRejectedValue(new Error("offline"));
      await vi.advanceTimersByTimeAsync(4100);
      expect(within(cardOf("Spring Push")).getByLabelText("Live dialing")).toHaveTextContent(/118\s*In queue/);
    });
  });

  describe("a campaign whose contacts all have a completed call", () => {
    const done = (over: Record<string, unknown> = {}) => campaign({ contacts_count: 10, completed_count: 10, status: "Active", ...over });

    it("with calls still open keeps Pause and does not say all contacts were reached", async () => {
      mock([done()]);
      liveMock(liveOf({ state: "finishing", active_now: 3, queued: 0 }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(within(cardOf("Spring Push")).getByRole("button", { name: /Pause/ })).toBeEnabled());
      expect(screen.queryByText(/All contacts reached/)).not.toBeInTheDocument();
      expect(within(cardOf("Spring Push")).getByText("Active")).toBeInTheDocument();
    });

    it("with redials still queued keeps Pause", async () => {
      mock([done()]);
      liveMock(liveOf({ state: "waiting_redials", active_now: 0, queued: 2, queued_redials: 2 }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(within(cardOf("Spring Push")).getByRole("button", { name: /Pause/ })).toBeEnabled());
    });

    it("with a run still open keeps Pause", async () => {
      mock([done({ dial_running: true, dialing: { settings: {}, running: true, stall_reason: null } })]);
      render(<Outbound />);
      await screen.findByText("Spring Push");
      expect(within(cardOf("Spring Push")).getByRole("button", { name: /Pause/ })).toBeEnabled();
    });

    it("with nothing open or queued is Completed", async () => {
      mock([done()]);
      liveMock(liveOf({ state: "idle", active_now: 0, queued: 0, queued_redials: 0 }));
      render(<Outbound />);
      await screen.findByText("Spring Push");
      await waitFor(() => expect(api.getCampaignsLive).toHaveBeenCalled());
      expect(within(cardOf("Spring Push")).getByRole("button", { name: /All contacts reached/ })).toBeDisabled();
      expect(within(cardOf("Spring Push")).queryByRole("button", { name: /Pause/ })).not.toBeInTheDocument();
    });
  });

  describe("saving and creating", () => {
    const openSettings = async () => {
      await screen.findByText("Spring Push");
      fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
      await screen.findByText("Campaign Basics");
    };

    it("opens the dialing step with the stored settings and saves a change", async () => {
      mock([campaign({ dial_strategy: "paced", dial_calls_per_minute: 30, dial_delay_seconds: 1 })]);
      render(<Outbound />);
      await openSettings();
      for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole("button", { name: /Next/ }));
      await screen.findByText("Choose how the campaign places its calls");
      expect(screen.getByRole("radio", { name: "Paced" })).toBeChecked();
      expect(screen.getByLabelText("Calls per Minute")).toHaveValue(30);
      fireEvent.change(screen.getByLabelText("Calls per Minute"), { target: { value: "45" } });
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
      expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({
        dial_strategy: "paced", dial_concurrent_calls: 5, dial_calls_per_minute: 45, dial_delay_seconds: 1,
      });
    });

    it("saving a campaign with no dial fields sends the four defaults", async () => {
      mock([campaign()]);
      render(<Outbound />);
      await openSettings();
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() => expect(api.updateCampaign).toHaveBeenCalled());
      expect(fn(api.updateCampaign).mock.calls[0][1]).toMatchObject({
        dial_strategy: "sequential", dial_concurrent_calls: 5, dial_calls_per_minute: 10, dial_delay_seconds: 0,
      });
    });

    it("a warning that comes back with a save is its own toast", async () => {
      mock([campaign({ dial_strategy: "concurrent", dial_concurrent_calls: 10 })]);
      fn(api.updateCampaign).mockResolvedValue({
        data: {}, warnings: ["Concurrent Calls is set to 10, but your account allows 3 calls at the same time. Calls will run 3 at a time."], error: null,
      });
      render(<Outbound />);
      await openSettings();
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/your account allows 3 calls/)));
      expect(toast.success).toHaveBeenCalledWith("Campaign updated");
    });

    it("a refused save raises no warnings", async () => {
      mock([campaign()]);
      fn(api.updateCampaign).mockResolvedValue({ data: null, warnings: ["x"], error: "No" });
      render(<Outbound />);
      await openSettings();
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No"));
      expect(toast.warning).not.toHaveBeenCalled();
    });

    const createThrough = async () => {
      await screen.findByText("Spring Push");
      fireEvent.click(screen.getAllByRole("button", { name: /New Campaign/ })[0]);
      await screen.findByText("Campaign Information");
      fireEvent.click(screen.getAllByRole("combobox")[1]);
      const numbers = await screen.findAllByText("+15550001111");
      fireEvent.click(numbers[numbers.length - 1]);
      fireEvent.change(screen.getByPlaceholderText(/Q3 Cold Outreach/), { target: { value: "Autumn" } });
      fireEvent.click(screen.getAllByRole("combobox")[0]);
      fireEvent.click(await screen.findByRole("option", { name: "Sara" }));
      fireEvent.click(screen.getByRole("button", { name: /Next/ }));
      fireEvent.click(screen.getAllByRole("combobox")[0]);
      fireEvent.click(await screen.findByRole("option", { name: /Leads/ }));
      for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: /Next/ }));
      await screen.findByText("Choose how the campaign places its calls");
      fireEvent.click(screen.getByRole("radio", { name: "Concurrent" }));
      fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "10" } });
      fireEvent.click(screen.getByRole("button", { name: /Next/ }));
      await screen.findByText("Campaign Summary");
      fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    };

    it("a new campaign is created with its dialing settings, and a warning is toasted after the wizard closes", async () => {
      mock([campaign()]);
      fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
      fn(api.getDialingLimits).mockResolvedValue({ data: { account_limit: 3, source: "account", platform_limit: null }, error: null });
      fn(api.createCampaign).mockResolvedValue({
        data: {}, warnings: ["Concurrent Calls is set to 10, but your account allows 3 calls at the same time. Calls will run 3 at a time."], error: null,
      });
      render(<Outbound />);
      await createThrough();
      await waitFor(() => expect(api.createCampaign).toHaveBeenCalled());
      expect(fn(api.createCampaign).mock.calls[0][0]).toMatchObject({
        name: "Autumn", dial_strategy: "concurrent", dial_concurrent_calls: 10, dial_calls_per_minute: 10, dial_delay_seconds: 0,
      });
      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/your account allows 3 calls/)));
      expect(toast.success).toHaveBeenCalledWith('Campaign "Autumn" created');
    });

    it("a refused create raises no warnings", async () => {
      mock([campaign()]);
      fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
      fn(api.createCampaign).mockResolvedValue({ data: null, warnings: ["x"], error: "Nope" });
      render(<Outbound />);
      await createThrough();
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope"));
      expect(toast.warning).not.toHaveBeenCalled();
    });
  });
});
