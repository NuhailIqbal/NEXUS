import { choose, pick } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vi as viConfig } from "vitest";
viConfig.setConfig({ testTimeout: 20000 });   // the 96-slot time list and the zone list render slowly in jsdom when the machine is busy
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getCampaigns: vi.fn(), getAgents: vi.fn(), getPhoneNumbers: vi.fn(), getAnalyticsOverview: vi.fn(), getContacts: vi.fn(),
    getLists: vi.fn(), getDncStatus: vi.fn(),
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
  fn(api.startCampaign).mockResolvedValue({ data: { dialed: 10, errors: 0, suppressed: 0 }, error: null });
  fn(api.resumeCampaign).mockResolvedValue({ data: { dialed: 3, errors: 0, suppressed: 0 }, error: null });
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
    expect(toast.success).toHaveBeenCalledWith("Dialing 10 contacts…");
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

  it("a stopped campaign is continued with resume", async () => {
    mock([withHours(OPEN_STATE, { status: "Paused", dial_cursor: "k5" })]);
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.resumeCampaign).toHaveBeenCalledWith("c1"));
    expect(api.startCampaign).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Dialing 3 contacts…");
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

  it("starting a campaign that is already running shows the server's reason", async () => {
    mock([withHours(OPEN_STATE)]);
    fn(api.startCampaign).mockResolvedValue({ data: null, error: "This campaign is already running. Pause it first if you want to stop it." });
    render(<Outbound />);
    await screen.findByText("Spring Push");
    startFrom(cardOf("Spring Push"));
    await waitFor(() => expect(launchButton()).toBeEnabled());
    fireEvent.click(launchButton());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already running/)));
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
  // The settings open the same five-step wizard as creating a campaign, starting from the campaign.
  const full = (over: Record<string, unknown> = {}) => campaign({
    status: "Paused", list_id: "l1", phone_number_id: "p1", dnc_screening_enabled: true,
    retry_enabled: true, retry_max_attempts: 4, retry_interval_minutes: 15, retry_on: ["busy", "failed"], ...over,
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

  it("is the creation wizard in edit mode: five steps, starting from the campaign", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    expect(screen.getByText("Edit")).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 5/)).toBeInTheDocument();
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
    expect(await screen.findByText("Review & Save")).toBeInTheDocument();
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
    });
    expect(toast.success).toHaveBeenCalledWith("Campaign updated");
    await waitFor(() => expect(screen.queryByText("Campaign Basics")).not.toBeInTheDocument());
  });

  it("saves from the last step too, with the same Save Changes button", async () => {
    withLists();
    render(<Outbound />);
    await openEdit();
    for (let i = 0; i < 4; i++) nextBtn();
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
    expect(screen.getByText(/Step 1 of 5/)).toBeInTheDocument();
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
