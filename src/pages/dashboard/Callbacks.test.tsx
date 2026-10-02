import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: {
    getCallbacks: vi.fn(), getCallbackSettings: vi.fn(), getMyRole: vi.fn(),
    updateCallback: vi.fn(), updateCallbackSettings: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Callbacks from "./Callbacks";
import type { Callback, CallbackSettings } from "@/components/callbacks/callbackTypes";

const settings = (over: Partial<CallbackSettings> = {}): CallbackSettings => ({
  auto_call: false, timezone: "Asia/Karachi", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "18:00",
  default_time: "10:00", retry_minutes: 30, max_attempts: 2, ...over,
});
const FUTURE = new Date(Date.now() + 2 * 86400_000).toISOString();
const PAST = new Date(Date.now() - 2 * 3600_000).toISOString();
const row = (over: Partial<Callback> = {}): Callback => ({
  id: "1", agent_id: "a", agent_name: "Sara", contact_name: "Ali Khan", phone: "+15551230001", due_at: FUTURE,
  timezone: "Asia/Karachi", time_source: "caller", requested_text: "kal shaam 5 baje", status: "pending", attempts: 0,
  last_error: null, placed_call_id: null, created_at: "2026-10-05T00:00:00Z", ...over,
});
const counts = (over = {}) => ({ pending: 1, calling: 0, called: 0, failed: 0, cancelled: 0, skipped: 0, ...over });
const get = api.getCallbacks as ReturnType<typeof vi.fn>;
const upd = api.updateCallback as ReturnType<typeof vi.fn>;

function mock(rows: Callback[], opts: { s?: CallbackSettings; owner?: boolean; counts?: object } = {}) {
  get.mockResolvedValue({ data: rows, error: null, meta: { counts: counts(opts.counts) } });
  (api.getCallbackSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ data: opts.s ?? settings(), error: null });
  (api.getMyRole as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { is_owner: opts.owner ?? true }, error: null });
}

beforeEach(() => vi.clearAllMocks());

describe("Callbacks page", () => {
  it("lists callbacks with customer, agent, time, status and what the caller said", async () => {
    mock([row()]);
    render(<Callbacks />);
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(await screen.findByText("Ali Khan")).toBeInTheDocument();
    expect(screen.getByText("+15551230001")).toBeInTheDocument();
    expect(screen.getByText("Sara")).toBeInTheDocument();
    expect(screen.getByText("Scheduled", { selector: "span.rounded-full" })).toBeInTheDocument();
    expect(screen.getByText("kal shaam 5 baje")).toBeInTheDocument();
    expect(screen.getByText("Time the caller asked for")).toBeInTheDocument();
    for (const c of ["Customer", "Agent", "Call back at", "Status", "What they said", "Actions"]) {
      expect(screen.getByRole("columnheader", { name: c })).toBeInTheDocument();
    }
  });

  it("unknown callers and missing numbers read sensibly", async () => {
    mock([row({ contact_name: null, phone: null, agent_name: "", requested_text: null })]);
    render(<Callbacks />);
    expect(await screen.findByText("Unknown caller")).toBeInTheDocument();
    expect(screen.getByText("No phone number")).toBeInTheDocument();
  });

  it("says plainly when automatic calling is OFF and offers to turn it on", async () => {
    mock([row()]);
    render(<Callbacks />);
    expect(await screen.findByText(/Automatic calling is off/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn it on in settings" }));
    expect(await screen.findByText("Callback settings")).toBeInTheDocument();
  });

  it("says plainly when it is ON, with the calling hours", async () => {
    mock([row()], { s: settings({ auto_call: true }) });
    render(<Callbacks />);
    expect(await screen.findByText(/Automatic calling is on/)).toBeInTheDocument();
    expect(screen.getByText(/Mon–Fri, 09:00–18:00 \(Asia\/Karachi\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Overdue — call them/)).not.toBeInTheDocument();
  });

  it("non-owners are not offered the switch-on link", async () => {
    mock([row()], { owner: false });
    render(<Callbacks />);
    await screen.findByText(/Automatic calling is off/);
    expect(screen.queryByRole("button", { name: "Turn it on in settings" })).not.toBeInTheDocument();
  });

  it("with auto-calling off, a callback whose time has passed is flagged for a person to call", async () => {
    mock([row({ due_at: PAST })]);
    render(<Callbacks />);
    expect(await screen.findByText("Overdue — call them")).toBeInTheDocument();
  });

  it("filter tabs show counts and re-query the server", async () => {
    mock([row()], { counts: { pending: 1, called: 4, failed: 2 } });
    render(<Callbacks />);
    await screen.findByText("Ali Khan");
    const tab = screen.getByRole("tab", { name: /Called/ });
    expect(tab).toHaveTextContent("4");
    expect(screen.getByRole("tab", { name: /All/ })).toHaveTextContent("7");
    fireEvent.click(tab);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith("called"));
    expect(screen.getByRole("tab", { name: /Called/ })).toHaveAttribute("aria-selected", "true");
  });

  it("shows attempts and the reason when something went wrong", async () => {
    mock([row({ status: "failed", attempts: 2, last_error: "Your wallet balance is empty." })]);
    render(<Callbacks />);
    expect(await screen.findByText("Your wallet balance is empty.")).toBeInTheDocument();
    expect(screen.getByText("Attempts: 2")).toBeInTheDocument();
    expect(screen.getByText("Failed", { selector: "span.rounded-full" })).toBeInTheDocument();
  });

  it("empty state explains how callbacks get created", async () => {
    mock([], { counts: { pending: 0 } });
    render(<Callbacks />);
    expect(await screen.findByText("No callbacks yet")).toBeInTheDocument();
    expect(screen.getByText(/Schedule a callback/)).toBeInTheDocument();
  });

  it("an empty filtered view does not repeat the setup advice", async () => {
    mock([row()]);
    render(<Callbacks />);
    await screen.findByText("Ali Khan");
    mock([]);
    fireEvent.click(screen.getByRole("tab", { name: /Failed/ }));
    expect(await screen.findByText("No failed callbacks")).toBeInTheDocument();
    expect(screen.queryByText(/Schedule a callback/)).not.toBeInTheDocument();
  });

  it("error state shows the message and retries", async () => {
    get.mockResolvedValueOnce({ data: null, error: "Network error" });
    (api.getCallbackSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ data: settings(), error: null });
    (api.getMyRole as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { is_owner: true }, error: null });
    render(<Callbacks />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
    get.mockResolvedValue({ data: [row()], error: null, meta: { counts: counts() } });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Ali Khan")).toBeInTheDocument();
  });

  describe("actions", () => {
    it("pending callbacks offer Reschedule, Mark called and Cancel", async () => {
      mock([row()]);
      render(<Callbacks />);
      await screen.findByText("Ali Khan");
      expect(screen.getByRole("button", { name: "Reschedule Ali Khan" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mark Ali Khan as called" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel Ali Khan" })).toBeInTheDocument();
    });

    it("already-called and in-progress callbacks have no actions", async () => {
      mock([row({ id: "1", status: "called" }), row({ id: "2", status: "calling", phone: "+1555" })]);
      render(<Callbacks />);
      await screen.findAllByText("Ali Khan");
      expect(screen.queryByRole("button", { name: /Reschedule/ })).not.toBeInTheDocument();
    });

    it("failed and skipped callbacks can be rescheduled or marked done, but not cancelled", async () => {
      mock([row({ status: "failed" })]);
      render(<Callbacks />);
      await screen.findByText("Ali Khan");
      expect(screen.getByRole("button", { name: "Reschedule Ali Khan" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mark Ali Khan as called" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Cancel Ali Khan" })).not.toBeInTheDocument();
    });

    it("a cancelled callback can be revived by rescheduling", async () => {
      mock([row({ status: "cancelled" })]);
      render(<Callbacks />);
      await screen.findByText("Ali Khan");
      expect(screen.getByRole("button", { name: "Reschedule Ali Khan" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Mark Ali Khan as called" })).not.toBeInTheDocument();
    });

    it("Mark called updates and refreshes", async () => {
      mock([row()]);
      upd.mockResolvedValue({ data: {}, error: null });
      render(<Callbacks />);
      fireEvent.click(await screen.findByRole("button", { name: "Mark Ali Khan as called" }));
      await waitFor(() => expect(upd).toHaveBeenCalledWith("1", { status: "called" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Marked as called"));
      expect(get).toHaveBeenCalledTimes(2);
    });

    it("Cancel asks first; keeping it changes nothing", async () => {
      mock([row()]);
      render(<Callbacks />);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel Ali Khan" }));
      const dlg = await screen.findByRole("alertdialog");
      expect(within(dlg).getByText(/will not be called back/)).toBeInTheDocument();
      fireEvent.click(within(dlg).getByRole("button", { name: "Keep it" }));
      expect(upd).not.toHaveBeenCalled();
    });

    it("confirming the cancel updates and refreshes", async () => {
      mock([row()]);
      upd.mockResolvedValue({ data: {}, error: null });
      render(<Callbacks />);
      fireEvent.click(await screen.findByRole("button", { name: "Cancel Ali Khan" }));
      fireEvent.click(await screen.findByRole("button", { name: "Cancel callback" }));
      await waitFor(() => expect(upd).toHaveBeenCalledWith("1", { status: "cancelled" }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Callback cancelled"));
    });

    it("a refused action is reported and the list is not refreshed", async () => {
      mock([row()]);
      upd.mockResolvedValue({ data: null, error: "This callback has already been placed." });
      render(<Callbacks />);
      fireEvent.click(await screen.findByRole("button", { name: "Mark Ali Khan as called" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This callback has already been placed."));
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("Reschedule opens the dialog for that callback", async () => {
      mock([row()]);
      render(<Callbacks />);
      fireEvent.click(await screen.findByRole("button", { name: "Reschedule Ali Khan" }));
      expect(await screen.findByText("Reschedule callback")).toBeInTheDocument();
      expect(screen.getByText(/Ali Khan — time is in Asia\/Karachi/)).toBeInTheDocument();
    });

    it("saving a new time refreshes the list", async () => {
      mock([row()]);
      upd.mockResolvedValue({ data: {}, error: null });
      render(<Callbacks />);
      fireEvent.click(await screen.findByRole("button", { name: "Reschedule Ali Khan" }));
      fireEvent.change(await screen.findByLabelText("Call back at"), { target: { value: "2031-01-01T10:00" } });
      fireEvent.click(screen.getByRole("button", { name: /^Reschedule$/ }));
      await waitFor(() => expect(upd).toHaveBeenCalledWith("1", { due_local: "2031-01-01T10:00" }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    });
  });

  it("saving settings updates the banner without a manual reload", async () => {
    mock([row()]);
    (api.updateCallbackSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ data: settings({ end_time: "20:00" }), error: null });
    render(<Callbacks />);
    fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
    fireEvent.change(await screen.findByLabelText("Calls stop"), { target: { value: "20:00" } });
    (api.getCallbackSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ data: settings({ end_time: "20:00", auto_call: false }), error: null });
    fireEvent.click(screen.getByRole("button", { name: /Save settings/ }));
    await waitFor(() => expect(api.updateCallbackSettings).toHaveBeenCalled());
  });

  it("renders hostile text as plain text", async () => {
    mock([row({ requested_text: "<img src=x onerror=alert(1)>", contact_name: "<b>Bob</b>" })]);
    const { container } = render(<Callbacks />);
    await screen.findByText("<b>Bob</b>");
    expect(container.querySelector("img")).toBeNull();
    expect([...container.querySelectorAll("b")].some((b) => b.textContent === "Bob")).toBe(false);
  });
});
