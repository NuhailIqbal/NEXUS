import { pick } from "@/test/pick";
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
    startCampaign: vi.fn(), pauseCampaign: vi.fn(), resumeCampaign: vi.fn(),
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
  const openSettings = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    return screen.findByRole("dialog");
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
  const openSettings = async () => {
    await screen.findByText("Spring Push");
    fireEvent.click(within(cardOf("Spring Push")).getByRole("button", { name: "Settings" }));
    return screen.findByRole("dialog");
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
