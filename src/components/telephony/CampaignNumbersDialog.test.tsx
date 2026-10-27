import { choose } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { getCampaignNumbers: vi.fn(), retryUnreached: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { CampaignNumbersDialog } from "./CampaignNumbersDialog";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const row = (over: Record<string, unknown> = {}) => ({
  id: "n1", contact_id: "k1", name: "Ada Lovelace", phone: "+15550001111", attempts: 1, round: 1, max_attempts: 3,
  last_outcome: "no_answer", last_attempt_at: "2026-10-14T12:00:30Z", next_attempt_at: "2026-10-14T12:10:30Z",
  final_status: null, status: "retry_scheduled",
  history: [{ round: 1, attempt_number: 1, placed_at: "2026-10-14T12:00:00Z", ended_at: "2026-10-14T12:00:30Z", outcome: "no_answer", ended_reason: "customer-did-not-answer" }],
  ...over,
});
const reply = (rows: object[], total = rows.length, retry = { enabled: true, max_attempts: 3, interval_minutes: 10 }) =>
  fn(api.getCampaignNumbers).mockResolvedValue({ data: { rows, total, retry }, error: null });

const renderDialog = () => render(<CampaignNumbersDialog campaignId="c1" campaignName="Spring Push" timezone="UTC" onOpenChange={vi.fn()} />);

beforeEach(() => vi.clearAllMocks());

describe("CampaignNumbersDialog", () => {
  it("shows each number with its attempt count, last outcome, next retry time and status", async () => {
    reply([row()]);
    renderDialog();
    expect(await screen.findByText("+15550001111")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(screen.getByText("No answer")).toBeInTheDocument();
    expect(screen.getByText(/Oct 14, 2026, 12:10 PM UTC/)).toBeInTheDocument();     // the campaign's own zone, named
    expect(screen.getByText("Redial scheduled")).toBeInTheDocument();
    expect(screen.getByText(/Up to 3 calls per number, 10 minutes after a call ends/)).toBeInTheDocument();
    expect(api.getCampaignNumbers).toHaveBeenCalledWith("c1", { status: "all", limit: 100, offset: 0 });
  });

  it("a number that reached the maximum says so and has no next retry", async () => {
    reply([row({ attempts: 3, final_status: "max_attempts", status: "max_attempts", next_attempt_at: null })]);
    renderDialog();
    expect(await screen.findByText("3 of 3")).toBeInTheDocument();
    expect(screen.getByText("Max attempts reached")).toBeInTheDocument();
    expect(screen.queryByText(/12:10 PM/)).not.toBeInTheDocument();
  });

  it("a retry held back by a paused campaign is labelled", async () => {
    reply([row({ status: "retry_paused" })]);
    renderDialog();
    expect(await screen.findByText(/Redial paused/)).toBeInTheDocument();
  });

  it("a row opens to the history of its calls", async () => {
    reply([row({ attempts: 2, history: [
      { round: 1, attempt_number: 1, placed_at: "2026-10-14T12:00:00Z", ended_at: "2026-10-14T12:00:30Z", outcome: "no_answer", ended_reason: null },
      { round: 1, attempt_number: 2, placed_at: "2026-10-14T12:10:30Z", ended_at: null, outcome: null, ended_reason: null },
    ] })]);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Show calls of +15550001111" }));
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Attempt 1");
    expect(items[0]).toHaveTextContent(/ended Oct 14, 2026, 12:00 PM UTC/);
    expect(items[1]).toHaveTextContent("Attempt 2");
    expect(items[1]).toHaveTextContent("in progress");
    fireEvent.click(screen.getByRole("button", { name: "Hide calls of +15550001111" }));
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("each call in the history says how it was placed: its slot and wave, or that it was a redial", async () => {
    reply([row({ attempts: 3, history: [
      { round: 1, attempt_number: 1, placed_at: "2026-10-14T12:00:00Z", ended_at: "2026-10-14T12:00:30Z", outcome: "no_answer", ended_reason: null,
        dial_strategy: "concurrent", dial_slot: 2, dial_batch: 1, dial_source: "fresh" },
      { round: 1, attempt_number: 2, placed_at: "2026-10-14T12:10:30Z", ended_at: "2026-10-14T12:11:00Z", outcome: "busy", ended_reason: null,
        dial_strategy: "concurrent", dial_slot: 1, dial_batch: 4, dial_source: "redial" },
      { round: 1, attempt_number: 3, placed_at: "2026-10-14T12:20:30Z", ended_at: null, outcome: null, ended_reason: null,
        dial_strategy: "paced", dial_slot: null, dial_batch: 7, dial_source: "redial" },
    ] })]);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Show calls of +15550001111" }));
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("slot 2 · wave 1");
    expect(items[0]).not.toHaveTextContent("redial");
    expect(items[1]).toHaveTextContent("slot 1 · wave 4 · redial");
    expect(items[2]).toHaveTextContent("paced · redial");
    expect(items[2]).not.toHaveTextContent("wave");
  });

  it("a call from before the dialing strategies shows no placement note", async () => {
    reply([row()]);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "Show calls of +15550001111" }));
    expect(screen.getByRole("listitem").textContent).not.toMatch(/slot|wave|redial/);
  });

  it("choosing a filter asks the server for that status", async () => {
    reply([row()]);
    renderDialog();
    await screen.findByText("+15550001111");
    await choose("Show", "Max attempts reached");
    await waitFor(() => expect(api.getCampaignNumbers).toHaveBeenLastCalledWith("c1", { status: "max_attempts", limit: 100, offset: 0 }));
  });

  it("loads more when there are more numbers than the page", async () => {
    fn(api.getCampaignNumbers).mockResolvedValueOnce({ data: { rows: [row()], total: 2, retry: { enabled: true, max_attempts: 3, interval_minutes: 10 } }, error: null });
    renderDialog();
    await screen.findByText("+15550001111");
    fn(api.getCampaignNumbers).mockResolvedValueOnce({ data: { rows: [row({ id: "n2", phone: "+15550002222" })], total: 2, retry: null }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("+15550002222")).toBeInTheDocument();
    expect(screen.getByText("+15550001111")).toBeInTheDocument();
    expect(api.getCampaignNumbers).toHaveBeenLastCalledWith("c1", { status: "all", limit: 100, offset: 1 });
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("explains an empty list, and that retry is off", async () => {
    reply([], 0, { enabled: false, max_attempts: 3, interval_minutes: 10 });
    renderDialog();
    expect(await screen.findByText("No calls have been placed by this campaign yet.")).toBeInTheDocument();
    expect(screen.getByText(/Auto redial is off for this campaign/)).toBeInTheDocument();
  });

  it("shows the server's error", async () => {
    fn(api.getCampaignNumbers).mockResolvedValue({ data: null, error: "Campaign not found" });
    renderDialog();
    expect(await within(await screen.findByRole("dialog")).findByRole("alert")).toHaveTextContent("Campaign not found");
  });

  it("does nothing while no campaign is chosen", () => {
    render(<CampaignNumbersDialog campaignId={null} onOpenChange={vi.fn()} />);
    expect(api.getCampaignNumbers).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("CampaignNumbersDialog: retry unreached numbers", () => {
  const renderRetry = (props: Record<string, unknown> = {}) => {
    const onRequeued = vi.fn();
    render(<CampaignNumbersDialog campaignId="c1" campaignName="Spring Push" timezone="UTC" status="Active" unreachedCount={3}
      onRequeued={onRequeued} onOpenChange={vi.fn()} {...props} />);
    return onRequeued;
  };
  const answer = (data: object) => fn(api.retryUnreached).mockResolvedValue({ data, error: null });
  const QUEUED = { requeued: 3, skipped_busy: 0, campaign_status: "Active", message: "3 numbers queued to be called again." };

  beforeEach(() => reply([row({ attempts: 3, final_status: "max_attempts", status: "max_attempts", next_attempt_at: null })]));

  it("offers the button, with the count, when numbers never picked up", async () => {
    renderRetry();
    expect(await screen.findByRole("button", { name: /Retry unreached numbers \(3\)/ })).toBeInTheDocument();
    expect(screen.getByText(/3 numbers never picked up, even after every redial/)).toBeInTheDocument();
  });

  it("says number, not numbers, for one", async () => {
    renderRetry({ unreachedCount: 1 });
    expect(await screen.findByRole("button", { name: /Retry unreached numbers \(1\)/ })).toBeInTheDocument();
    expect(screen.getByText(/1 number never picked up/)).toBeInTheDocument();
  });

  it.each([
    ["nothing is unreached", { unreachedCount: 0 }],
    ["the count is not known", { unreachedCount: undefined }],
    ["a pass is still going", { running: true }],
  ])("shows no button when %s", async (_why, props) => {
    renderRetry(props);
    await screen.findByText("+15550001111");
    expect(screen.queryByRole("button", { name: /Retry unreached numbers/ })).not.toBeInTheDocument();
  });

  it("asks first, and does nothing until it is confirmed", async () => {
    renderRetry();
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    const box = screen.getByRole("group", { name: "Confirm retrying unreached numbers" });
    expect(box).toHaveTextContent("Call 3 numbers that never picked up again?");
    expect(box).toHaveTextContent("Numbers that answered, were transferred, disqualified or asked not to be called are not called.");
    expect(api.retryUnreached).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm retrying unreached numbers" })).not.toBeInTheDocument();
    expect(api.retryUnreached).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Retry unreached numbers/ })).toBeInTheDocument();
  });

  it("an Active campaign: one confirm calls the API without activating, toasts the result and refreshes", async () => {
    answer(QUEUED);
    const onRequeued = renderRetry();
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    expect(screen.queryByRole("button", { name: /Only queue them/ })).not.toBeInTheDocument();
    const loads = fn(api.getCampaignNumbers).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Call them again" }));
    await waitFor(() => expect(api.retryUnreached).toHaveBeenCalledWith("c1", { activate: false }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("3 numbers queued to be called again."));
    await waitFor(() => expect(fn(api.getCampaignNumbers).mock.calls.length).toBe(loads + 1));
    expect(onRequeued).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Confirm retrying unreached numbers" })).not.toBeInTheDocument();
  });

  it("a campaign that is not Active offers to start it, or only to queue the numbers", async () => {
    answer({ ...QUEUED, campaign_status: "Paused", message: "3 numbers queued. They will be dialed when the campaign is Active." });
    renderRetry({ status: "Paused" });
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    expect(screen.getByRole("group", { name: "Confirm retrying unreached numbers" })).toHaveTextContent(/not running/);
    expect(screen.queryByRole("button", { name: "Call them again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Only queue them" }));
    await waitFor(() => expect(api.retryUnreached).toHaveBeenCalledWith("c1", { activate: false }));
    expect(toast.success).toHaveBeenCalledWith("3 numbers queued. They will be dialed when the campaign is Active.");
  });

  it("start campaign and call them sends activate: true", async () => {
    answer({ ...QUEUED, message: "3 numbers queued to be called again." });
    renderRetry({ status: "Inactive" });
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    fireEvent.click(screen.getByRole("button", { name: /Call them now \(start campaign\)/ }));
    await waitFor(() => expect(api.retryUnreached).toHaveBeenCalledWith("c1", { activate: true }));
  });

  it("zero requeued is an info message, not a success or an error", async () => {
    answer({ requeued: 0, skipped_busy: 0, campaign_status: "Active", message: "There are no unreached numbers to call again." });
    renderRetry();
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Call them again" }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith("There are no unreached numbers to call again."));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("a failure is shown as an error, keeps the confirm open and does not refresh", async () => {
    fn(api.retryUnreached).mockResolvedValue({ data: null, error: "Campaign not found" });
    const onRequeued = renderRetry();
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Call them again" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Campaign not found"));
    expect(onRequeued).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm retrying unreached numbers" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Call them again" })).not.toBeDisabled());
  });

  it("the buttons are disabled while the request is out, so a double click sends one", async () => {
    let finish: (v: unknown) => void = () => {};
    fn(api.retryUnreached).mockReturnValue(new Promise((r) => { finish = r; }));
    renderRetry();
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    const go = screen.getByRole("button", { name: "Call them again" });
    fireEvent.click(go);
    await waitFor(() => expect(go).toBeDisabled());
    fireEvent.click(go);
    expect(api.retryUnreached).toHaveBeenCalledTimes(1);
    finish({ data: QUEUED, error: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it("never names the carrier", async () => {
    renderRetry({ status: "Paused" });
    fireEvent.click(await screen.findByRole("button", { name: /Retry unreached numbers/ }));
    expect(screen.getByRole("dialog").textContent).not.toMatch(/vapi/i);
  });
});
