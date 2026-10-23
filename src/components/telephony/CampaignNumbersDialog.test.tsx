import { choose } from "@/test/pick";
import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({ api: { getCampaignNumbers: vi.fn() } }));

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
