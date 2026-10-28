import { choose, pick } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vi as viConfig } from "vitest";
viConfig.setConfig({ testTimeout: 20000 });   // the 96-slot time list and the zone list render slowly in jsdom when the machine is busy
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getAgents: vi.fn(), getLists: vi.fn(), getPhoneNumbers: vi.fn(), getDncStatus: vi.fn(), getDialingLimits: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { defaultHours } from "@/components/hours/callingHours";
import { CreateCampaignDialog, EditCampaignDialog, type CampaignData } from "./CreateCampaignDialog";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara" }], error: null });
  fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
  fn(api.getPhoneNumbers).mockResolvedValue({ data: [{ id: "p1", number: "+15550001111" }], error: null });
  fn(api.getDncStatus).mockResolvedValue({ data: { enabled: false, integration_id: null }, error: null });
  fn(api.getDialingLimits).mockResolvedValue({
    data: { account_limit: null, source: null, platform_limit: null, max_concurrent_calls: 20, max_calls_per_minute: 60, max_delay_seconds: 60 },
    error: null,
  });
});

/** Fills step 1 (name, number, agent). The number is chosen first: with the agent dropdown
 * closed, the number's popover is the only open list. */
async function fillBasics() {
  await screen.findByText("Campaign Basics");
  fireEvent.click(screen.getAllByRole("combobox")[1]);
  fireEvent.click(await screen.findByText("+15550001111"));
  fireEvent.change(screen.getByPlaceholderText(/Q3 Cold Outreach/), { target: { value: "Spring" } });
  fireEvent.click(screen.getAllByRole("combobox")[0]);
  fireEvent.click(await screen.findByRole("option", { name: "Sara" }));
}
const next = () => fireEvent.click(screen.getByRole("button", { name: /Next/ }));
const DIALING_SUBTITLE = "Choose how the campaign places its calls";
/** From the Auto Redial step: Next to the Dialing Strategy step, then Next again (the review follows). */
async function pastRetry() {
  next();
  await screen.findByText(DIALING_SUBTITLE);
  next();
}
/** From the review: Previous back to the Auto Redial step. */
async function backToRetry() {
  fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
  await screen.findByText(DIALING_SUBTITLE);
  fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
  await screen.findByText("Call again when a number does not pick up");
}

/** Step 1 -> 2 -> 3: fills the basics, picks the list, and lands on the Calling Hours step. */
async function toHoursStep() {
  await fillBasics();
  next();
  fireEvent.click(screen.getAllByRole("combobox")[0]);
  fireEvent.click(await screen.findByRole("option", { name: /Leads/ }));
  next();
  await screen.findByText("Days and times the campaign may call");
}

const hoursSwitch = () => screen.getByRole("switch", { name: "Only call during set hours" });
/** Switches the hours on and chooses a time zone (none is pre-selected). */
async function enableHours() {
  fireEvent.click(hoursSwitch());
  await pick("Timezone", "karachi");
}

describe("CreateCampaignDialog: calling hours step", () => {
  it("the wizard has six steps and step 1 no longer carries the hours", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await screen.findByText("Campaign Basics");
    expect(screen.getByText(/Step 1 of 6/)).toBeInTheDocument();
    expect(screen.queryByText("Calling Hours")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Only call during set hours" })).not.toBeInTheDocument();
  });

  it("step 3 is Calling Hours: off by default, and switching on reveals the pickers", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    expect(screen.getByText(/Step 3 of 6/)).toBeInTheDocument();
    expect(hoursSwitch()).not.toBeChecked();
    expect(screen.queryByLabelText("Calls start")).not.toBeInTheDocument();
    fireEvent.click(hoursSwitch());
    // no time zone is pre-selected: the field starts on its placeholder
    expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
    expect(screen.getByLabelText("Calls start")).toHaveTextContent("9:00 AM");
    expect(screen.getByLabelText("Calls stop")).toHaveTextContent("5:00 PM");
    expect(screen.getByRole("button", { name: "Mon" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Sun" })).toHaveAttribute("aria-pressed", "false");
  });

  it("switched on without choosing a time zone, the wizard stops at step 3 and asks for one", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    fireEvent.click(hoursSwitch());
    next();
    expect(toast.error).toHaveBeenCalledWith("Select a time zone.");
    expect(screen.getByText(/Step 3 of 6/)).toBeInTheDocument();
    await pick("Timezone", "karachi");
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    await screen.findByText("Campaign Summary");
  });

  it("the suggestion link fills in the user's time zone in one click", async () => {
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: "Asia/Karachi" } as Intl.ResolvedDateTimeFormatOptions);
    try {
      render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
      await toHoursStep();
      fireEvent.click(hoursSwitch());
      expect(screen.getByLabelText("Timezone")).toHaveTextContent("Select time zone");
      fireEvent.click(screen.getByRole("button", { name: /Use my time zone/ }));
      expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
      next();
      await screen.findByText("Call again when a number does not pick up");
      await pastRetry();
      await screen.findByText("Campaign Summary");
    } finally {
      spy.mockRestore();
    }
  });

  it("hours with no day selected stop the wizard at step 3 with the reason", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    await enableHours();
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByRole("button", { name: d }));
    next();
    expect(toast.error).toHaveBeenCalledWith("Pick at least one day.");
    expect(screen.getByText(/Step 3 of 6/)).toBeInTheDocument();
  });

  it("switched off, nothing is checked and the wizard moves on", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    await screen.findByText("Campaign Summary");
    expect(screen.getByText(/Step 6 of 6/)).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("the chosen hours reach the review step and the created campaign", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toHoursStep();
    await enableHours();
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();

    const review = await screen.findByText("Campaign Summary");
    const tile = within(review.closest("div.rounded-xl") as HTMLElement).getByText("Calling Hours").parentElement as HTMLElement;
    expect(tile).toHaveTextContent(/Mon–Sat, 9:00 AM–5:00 PM \(Asia\/Karachi\)/);

    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0].hours).toMatchObject({ enabled: true, days: [0, 1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
  });

  it("without hours the review says any time, and the campaign is created with hours off", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toHoursStep();
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    await screen.findByText("Campaign Summary");
    expect(screen.getByText("Any time")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].hours.enabled).toBe(false);
  });

  it("Previous from the review returns to the hours step (through Dialing and Auto Redial) with the choices kept", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    await enableHours();
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    await screen.findByText("Campaign Summary");
    await backToRetry();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Days and times the campaign may call");
    expect(hoursSwitch()).toBeChecked();
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
  });
});

describe("CreateCampaignDialog: breaks and a custom schedule", () => {
  const radio = (name: string) => screen.getByRole("radio", { name });
  const reviewHours = async () => {
    const review = await screen.findByText("Campaign Summary");
    return (within(review.closest("div.rounded-xl") as HTMLElement).getByText("Calling Hours").parentElement as HTMLElement);
  };

  it("a break is added at step 3, shown in the review and sent with the campaign", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toHoursStep();
    await enableHours();
    fireEvent.click(screen.getByRole("button", { name: "Add break" }));
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    expect(await reviewHours()).toHaveTextContent("Mon–Fri, 9:00 AM–5:00 PM, break 1:00 PM–2:00 PM (Asia/Karachi)");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].hours).toMatchObject({ mode: "same", breaks: [{ start: "13:00", end: "14:00" }] });
  });

  it("a break that ends before it starts stops the wizard at step 3 with the reason", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    await enableHours();
    fireEvent.click(screen.getByRole("button", { name: "Add break" }));
    await choose("Break 1 end", "12:00 PM");
    expect(screen.getByRole("alert")).toHaveTextContent("A break must end after it starts.");
    next();
    expect(toast.error).toHaveBeenCalledWith("A break must end after it starts.");
    expect(screen.getByText(/Step 3 of 6/)).toBeInTheDocument();
  });

  it("a custom schedule per day is summarised by day in the review and kept when going back", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toHoursStep();
    await enableHours();
    fireEvent.click(radio("Custom schedule per day"));
    fireEvent.click(screen.getByRole("switch", { name: "Saturday" }));
    await choose("Saturday end", "1:00 PM");
    fireEvent.click(screen.getByRole("button", { name: "Add Monday break" }));
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    expect(await reviewHours()).toHaveTextContent("Mon 9:00 AM–5:00 PM (break 1:00 PM–2:00 PM); Tue–Fri 9:00 AM–5:00 PM; Sat 9:00 AM–1:00 PM (Asia/Karachi)");

    await backToRetry();
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Days and times the campaign may call");
    expect(radio("Custom schedule per day")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Saturday end")).toHaveTextContent("1:00 PM");
    next();
    await screen.findByText("Call again when a number does not pick up");
    await pastRetry();
    await screen.findByText("Campaign Summary");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].hours.mode).toBe("per_day");
  });

  it("a problem on one day stops the wizard and names the day", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    await enableHours();
    fireEvent.click(radio("Custom schedule per day"));
    await choose("Wednesday end", "8:00 AM");
    next();
    expect(toast.error).toHaveBeenCalledWith("Wednesday: End time must be after start time.");
    expect(screen.getByText(/Step 3 of 6/)).toBeInTheDocument();
  });
});

describe("CreateCampaignDialog: auto redial step", () => {
  const retrySwitch = () => screen.getByRole("switch", { name: "Enable auto redial" });
  /** Wizard on the Call Retry step (step 4), hours left off. */
  async function toRetryStep() {
    await toHoursStep();
    next();
    await screen.findByText("Call again when a number does not pick up");
  }
  const reviewTile = async (label: string) => {
    const review = await screen.findByText("Campaign Summary");
    return within(review.closest("div.rounded-xl") as HTMLElement).getByText(label).parentElement as HTMLElement;
  };

  it("step 4 is Auto Redial and it is off by default", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toRetryStep();
    expect(screen.getByText(/Step 4 of 6/)).toBeInTheDocument();
    expect(retrySwitch()).not.toBeChecked();
    expect(screen.queryByLabelText("Calls per number")).not.toBeInTheDocument();
  });

  it("left off, the review says Off and the campaign is created with retry off", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toRetryStep();
    await pastRetry();
    expect(await reviewTile("Auto Redial")).toHaveTextContent("Off");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].retry).toEqual({
      enabled: false, maxAttempts: 3, intervalMinutes: 10, retryOn: ["no_answer", "busy", "voicemail", "failed"], followupRounds: 0, followupGapHours: 24,
    });
  });

  it("the chosen settings reach the review and the created campaign", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    await choose("Calls per number", "5 calls");
    await choose("Wait between calls", "15 minutes");
    fireEvent.click(screen.getByRole("checkbox", { name: "Busy" }));
    await pastRetry();
    expect(await reviewTile("Auto Redial")).toHaveTextContent("Up to 5 calls per number, 15 min apart, on no answer, voicemail, call failed");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].retry).toEqual({
      enabled: true, maxAttempts: 5, intervalMinutes: 15, retryOn: ["no_answer", "voicemail", "failed"], followupRounds: 0, followupGapHours: 24,
    });
  });

  it("with retry on and nothing ticked the wizard stops on this step and says why", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    for (const name of ["No Answer", "Busy", "Voicemail / Answering Machine", "Call Failed / Network Error"]) {
      fireEvent.click(screen.getByRole("checkbox", { name }));
    }
    next();
    expect(toast.error).toHaveBeenCalledWith("Choose at least one outcome to redial on.");
    expect(screen.getByText(/Step 4 of 6/)).toBeInTheDocument();
  });

  it("follow-up rounds are off by default: the review says Off and none are asked for", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toRetryStep();
    expect(screen.getByLabelText("Rounds")).toBeDisabled();
    fireEvent.click(retrySwitch());
    expect(screen.getByLabelText("Rounds")).toHaveTextContent("Off");
    await pastRetry();
    expect(await reviewTile("Follow-up rounds")).toHaveTextContent("Off");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].retry).toMatchObject({ followupRounds: 0, followupGapHours: 24 });
  });

  it("the chosen rounds and wait reach the review and the created campaign", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    await choose("Rounds", "2 rounds");
    fireEvent.click(screen.getByRole("button", { name: "12 h" }));
    await pastRetry();
    expect(await reviewTile("Follow-up rounds")).toHaveTextContent("2 rounds, 12 h apart");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].retry).toMatchObject({ enabled: true, followupRounds: 2, followupGapHours: 12 });
  });

  it("a wait outside 1 to 48 hours stops the wizard on this step and says why", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    await choose("Rounds", "1 round");
    fireEvent.change(screen.getByLabelText("Wait between rounds"), { target: { value: "72" } });
    next();
    expect(toast.error).toHaveBeenCalledWith("Wait between rounds must be a whole number of hours from 1 to 48.");
    expect(screen.getByText(/Step 4 of 6/)).toBeInTheDocument();
  });

  it("rounds chosen and then Auto Redial switched off read as Off in the review", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    await choose("Rounds", "3 rounds");
    fireEvent.click(retrySwitch());
    await pastRetry();
    expect(await reviewTile("Follow-up rounds")).toHaveTextContent("Off");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].retry).toMatchObject({ enabled: false, followupRounds: 0 });
  });

  it("the rounds are kept when going back and forth", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    await choose("Rounds", "3 rounds");
    fireEvent.click(screen.getByRole("button", { name: "48 h" }));
    await pastRetry();
    await screen.findByText("Campaign Summary");
    await backToRetry();
    expect(screen.getByLabelText("Rounds")).toHaveTextContent("3 rounds");
    expect(screen.getByLabelText("Wait between rounds")).toHaveValue(48);
  });

  it("the choices are kept when going back and forth", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toRetryStep();
    fireEvent.click(retrySwitch());
    await choose("Wait between calls", "30 minutes");
    await pastRetry();
    await screen.findByText("Campaign Summary");
    await backToRetry();
    expect(retrySwitch()).toBeChecked();
    expect(screen.getByLabelText("Wait between calls")).toHaveTextContent("30 minutes");
  });
});

describe("CreateCampaignDialog: dialing strategy step", () => {
  const strategy = (name: string) => screen.getByRole("radio", { name });
  /** Wizard on the Dialing Strategy step (step 5), hours and redial left off. */
  async function toDialingStep() {
    await toHoursStep();
    next();
    await screen.findByText("Call again when a number does not pick up");
    next();
    await screen.findByText(DIALING_SUBTITLE);
  }
  const reviewTile = async (label: string) => {
    const review = await screen.findByText("Campaign Summary");
    return within(review.closest("div.rounded-xl") as HTMLElement).getByText(label).parentElement as HTMLElement;
  };

  it("step 5 is Dialing Strategy, after Auto Redial, with Sequential chosen by default", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    expect(screen.getByText(/Step 5 of 6/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dialing Strategy", level: 3 })).toBeInTheDocument();
    expect(strategy("Sequential")).toBeChecked();
    expect(screen.queryByLabelText("Concurrent Calls")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Calls per Minute")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Delay between calls (seconds)")).toHaveValue(0);
  });

  it("Concurrent and Paced each reveal their own number", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    fireEvent.click(strategy("Concurrent"));
    expect(screen.getByLabelText("Concurrent Calls")).toHaveValue(5);
    expect(screen.queryByLabelText("Calls per Minute")).not.toBeInTheDocument();
    fireEvent.click(strategy("Paced"));
    expect(screen.getByLabelText("Calls per Minute")).toHaveValue(10);
    expect(screen.queryByLabelText("Concurrent Calls")).not.toBeInTheDocument();
  });

  it("left on the default, the review says Sequential and the campaign is created Sequential", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toDialingStep();
    next();
    expect(await reviewTile("Dialing Strategy")).toHaveTextContent("Sequential: one call at a time");
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].dialing).toEqual({ strategy: "sequential", concurrentCalls: 5, callsPerMinute: 10, delaySeconds: 0 });
  });

  it("the chosen settings reach the review and the created campaign", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toDialingStep();
    fireEvent.click(strategy("Concurrent"));
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Delay between calls (seconds)"), { target: { value: "2" } });
    next();
    expect(await reviewTile("Dialing Strategy")).toHaveTextContent("Concurrent: up to 8 calls at a time, 2 s between calls");
    expect(screen.getByText(/Step 6 of 6/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    expect(onCreate.mock.calls[0][0].dialing).toEqual({ strategy: "concurrent", concurrentCalls: 8, callsPerMinute: 10, delaySeconds: 2 });
  });

  it("a Paced campaign is described with its rate", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    fireEvent.click(strategy("Paced"));
    fireEvent.change(screen.getByLabelText("Calls per Minute"), { target: { value: "30" } });
    next();
    expect(await reviewTile("Dialing Strategy")).toHaveTextContent("Paced: 30 calls per minute");
  });

  it("a number out of range stops the wizard on this step and says why", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    fireEvent.click(strategy("Concurrent"));
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "25" } });
    next();
    expect(toast.error).toHaveBeenCalledWith("Concurrent calls must be a whole number from 1 to 20.");
    expect(screen.getByText(/Step 5 of 6/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "20" } });
    next();
    await screen.findByText("Campaign Summary");
  });

  it("a delay out of range stops the wizard too, whichever strategy is chosen", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    fireEvent.change(screen.getByLabelText("Delay between calls (seconds)"), { target: { value: "90" } });
    next();
    expect(toast.error).toHaveBeenCalledWith("Delay between calls must be a whole number of seconds from 0 to 60.");
    expect(screen.getByText(/Step 5 of 6/)).toBeInTheDocument();
  });

  it("the choices are kept when going back and forth", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    fireEvent.click(strategy("Paced"));
    fireEvent.change(screen.getByLabelText("Calls per Minute"), { target: { value: "20" } });
    next();
    await screen.findByText("Campaign Summary");
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText(DIALING_SUBTITLE);
    expect(strategy("Paced")).toBeChecked();
    expect(screen.getByLabelText("Calls per Minute")).toHaveValue(20);
  });

  it("asks for the account's call limit when it opens", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await screen.findByText("Campaign Basics");
    expect(api.getDialingLimits).toHaveBeenCalledTimes(1);
  });

  it("warns on the step and the review when the settings ask for more than the account allows", async () => {
    fn(api.getDialingLimits).mockResolvedValue({ data: { account_limit: 3, source: "account", platform_limit: null }, error: null });
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    expect(screen.queryByText(/your account allows/)).not.toBeInTheDocument();
    fireEvent.click(strategy("Concurrent"));
    expect(screen.getByText(/but your account allows 3 calls at the same time/)).toBeInTheDocument();
    next();
    await screen.findByText("Campaign Summary");
    expect(screen.getByText(/Calls will run 3 at a time/)).toBeInTheDocument();
  });

  it("without a limit, or when the limits cannot be read, there is no warning and the wizard still works", async () => {
    fn(api.getDialingLimits).mockResolvedValue({ data: null, error: "Error 500" });
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toDialingStep();
    fireEvent.click(strategy("Concurrent"));
    fireEvent.change(screen.getByLabelText("Concurrent Calls"), { target: { value: "20" } });
    expect(screen.queryByText(/your account allows/)).not.toBeInTheDocument();
    next();
    await screen.findByText("Campaign Summary");
  });

  it("when editing, the step starts from the campaign's settings and says changes apply from now on", async () => {
    const initial: CampaignData = {
      status: "Active", name: "Spring", description: "", agentId: "a1", listId: "l1", phoneNumberId: "p1",
      dncScreeningEnabled: true,
      hours: defaultHours(),
      retry: { enabled: false, maxAttempts: 3, intervalMinutes: 10, retryOn: ["no_answer", "busy", "voicemail", "failed"], followupRounds: 0, followupGapHours: 24 },
      dialing: { strategy: "paced", concurrentCalls: 5, callsPerMinute: 24, delaySeconds: 1 },
    };
    const onSave = vi.fn().mockResolvedValue(true);
    render(<EditCampaignDialog open onOpenChange={vi.fn()} initial={initial} onSave={onSave} />);
    await screen.findByText("Campaign Basics");
    next(); next(); next(); next();
    await screen.findByText(DIALING_SUBTITLE);
    expect(strategy("Paced")).toBeChecked();
    expect(screen.getByLabelText("Calls per Minute")).toHaveValue(24);
    expect(screen.getByLabelText("Delay between calls (seconds)")).toHaveValue(1);
    expect(screen.getByText(/not to calls already in progress/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].dialing).toEqual({ strategy: "paced", concurrentCalls: 5, callsPerMinute: 24, delaySeconds: 1 });
  });

  it("when editing, the follow-up rounds start from the campaign's and are saved with the rest", async () => {
    const initial: CampaignData = {
      status: "Active", name: "Spring", description: "", agentId: "a1", listId: "l1", phoneNumberId: "p1",
      dncScreeningEnabled: true,
      hours: defaultHours(),
      retry: { enabled: true, maxAttempts: 3, intervalMinutes: 10, retryOn: ["no_answer", "busy", "voicemail", "failed"], followupRounds: 2, followupGapHours: 6 },
      dialing: { strategy: "sequential", concurrentCalls: 5, callsPerMinute: 10, delaySeconds: 0 },
    };
    const onSave = vi.fn().mockResolvedValue(true);
    render(<EditCampaignDialog open onOpenChange={vi.fn()} initial={initial} onSave={onSave} />);
    await screen.findByText("Campaign Basics");
    next(); next(); next();
    await screen.findByText("Call again when a number does not pick up");
    expect(screen.getByLabelText("Rounds")).toHaveTextContent("2 rounds");
    expect(screen.getByLabelText("Wait between rounds")).toHaveValue(6);
    await choose("Rounds", "3 rounds");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].retry).toMatchObject({ enabled: true, followupRounds: 3, followupGapHours: 6 });
  });
});
