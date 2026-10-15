import { pick } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vi as viConfig } from "vitest";
viConfig.setConfig({ testTimeout: 20000 });   // the 96-slot time list and the zone list render slowly in jsdom when the machine is busy
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getAgents: vi.fn(), getLists: vi.fn(), getPhoneNumbers: vi.fn(), getDncStatus: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CreateCampaignDialog } from "./CreateCampaignDialog";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fn(api.getAgents).mockResolvedValue({ data: [{ id: "a1", name: "Sara" }], error: null });
  fn(api.getLists).mockResolvedValue({ data: [{ id: "l1", name: "Leads", contact_count: 4 }], error: null });
  fn(api.getPhoneNumbers).mockResolvedValue({ data: [{ id: "p1", number: "+15550001111" }], error: null });
  fn(api.getDncStatus).mockResolvedValue({ data: { enabled: false, integration_id: null }, error: null });
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
  it("the wizard has four steps and step 1 no longer carries the hours", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await screen.findByText("Campaign Basics");
    expect(screen.getByText(/Step 1 of 4/)).toBeInTheDocument();
    expect(screen.queryByText("Calling Hours")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Only call during set hours" })).not.toBeInTheDocument();
  });

  it("step 3 is Calling Hours: off by default, and switching on reveals the pickers", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    expect(screen.getByText(/Step 3 of 4/)).toBeInTheDocument();
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
    expect(screen.getByText(/Step 3 of 4/)).toBeInTheDocument();
    await pick("Timezone", "karachi");
    next();
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
    expect(screen.getByText(/Step 3 of 4/)).toBeInTheDocument();
  });

  it("switched off, nothing is checked and the wizard moves on", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    next();
    await screen.findByText("Campaign Summary");
    expect(screen.getByText(/Step 4 of 4/)).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("the chosen hours reach the review step and the created campaign", async () => {
    const onCreate = vi.fn();
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} onCreate={onCreate} />);
    await toHoursStep();
    await enableHours();
    fireEvent.click(screen.getByRole("button", { name: "Sat" }));
    next();

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
    await screen.findByText("Campaign Summary");
    expect(screen.getByText("Any time")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Launch Campaign/ }));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0][0].hours.enabled).toBe(false);
  });

  it("Previous from the review returns to the hours step with the choices kept", async () => {
    render(<CreateCampaignDialog open onOpenChange={vi.fn()} />);
    await toHoursStep();
    await enableHours();
    next();
    await screen.findByText("Campaign Summary");
    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await screen.findByText("Days and times the campaign may call");
    expect(hoursSwitch()).toBeChecked();
    expect(screen.getByLabelText("Timezone")).toHaveTextContent(/Pakistan/);
  });
});
