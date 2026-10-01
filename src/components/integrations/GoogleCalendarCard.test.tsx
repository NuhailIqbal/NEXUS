import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

vi.mock("@/services/api", () => ({
  api: {
    getCalendarStatus: vi.fn(), getMyRole: vi.fn(), getCalendarConnectUrl: vi.fn(),
    disconnectCalendar: vi.fn(), updateCalendarSettings: vi.fn(),
  },
}));
vi.mock("@/lib/navigate", () => ({ redirectTo: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import { redirectTo } from "@/lib/navigate";
import { GoogleCalendarCard } from "./GoogleCalendarCard";
import type { CalendarStatus } from "./calendarTypes";

const settings = {
  timezone: "Asia/Karachi", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "17:00",
  slot_minutes: 30, buffer_minutes: 0, min_notice_hours: 2, max_days_ahead: 30,
};
const status = (over: Partial<CalendarStatus> = {}): CalendarStatus => ({
  configured: true, redirect_uri: "http://localhost:8000/calendar/google/callback", connected: false, status: null, email: null, settings, ...over,
});
const mockStatus = (s: CalendarStatus, owner = true) => {
  (api.getCalendarStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: s, error: null });
  (api.getMyRole as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { is_owner: owner }, error: null });
};

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
}
const show = (url = "/dashboard/integrations") =>
  render(<MemoryRouter initialEntries={[url]}><GoogleCalendarCard /><Where /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe("GoogleCalendarCard", () => {
  it("shows nothing while no calendar is connected (it appears once added via Add Integration)", async () => {
    mockStatus(status());
    const { container } = show();
    await waitFor(() => expect(api.getCalendarStatus).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByText("Calendar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect/ })).not.toBeInTheDocument();
  });

  it("shows nothing on a server without Google credentials either", async () => {
    mockStatus(status({ configured: false }));
    const { container } = show();
    await waitFor(() => expect(api.getCalendarStatus).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });

  it("connected: shows the account, the bookable hours, and the actions", async () => {
    mockStatus(status({ connected: true, status: "connected", email: "owner@gmail.com" }));
    show();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("as owner@gmail.com")).toBeInTheDocument();
    expect(screen.getByText(/Mon–Fri, 09:00–17:00 \(Asia\/Karachi\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Settings/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("connected as a non-owner: read only", async () => {
    mockStatus(status({ connected: true, status: "connected", email: "o@g.com" }), false);
    show();
    expect(await screen.findByText(/Only the account owner can change calendar settings/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("expired connection: warns and offers Reconnect", async () => {
    mockStatus(status({ connected: true, status: "reauth_required", email: "o@g.com" }));
    show();
    expect(await screen.findByText("Needs to be reconnected")).toBeInTheDocument();
    expect(screen.getByText(/settings are kept/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("Reconnect starts Google sign-in with the browser timezone", async () => {
    mockStatus(status({ connected: true, status: "reauth_required", email: "o@g.com" }));
    (api.getCalendarConnectUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }, error: null });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(redirectTo).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
    expect((api.getCalendarConnectUrl as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$|^UTC$/);
  });

  it("a failed reconnect start shows the error and stays on the page", async () => {
    mockStatus(status({ connected: true, status: "reauth_required" }));
    (api.getCalendarConnectUrl as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: "Google Calendar isn't set up on this server yet." });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Google Calendar isn't set up on this server yet."));
    expect(redirectTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  });

  it("settings opens the dialog prefilled", async () => {
    mockStatus(status({ connected: true, status: "connected" }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
    expect(await screen.findByText("Calendar settings")).toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toHaveValue("Asia/Karachi");
  });

  it("saved settings update the summary without a reload", async () => {
    mockStatus(status({ connected: true, status: "connected" }));
    (api.updateCalendarSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { ...settings, end_time: "18:30" }, error: null });
    show();
    fireEvent.click(await screen.findByRole("button", { name: /Settings/ }));
    fireEvent.change(await screen.findByLabelText("Day ends"), { target: { value: "18:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/09:00–18:30/)).toBeInTheDocument();
  });

  it("disconnect asks first, then removes and refreshes", async () => {
    mockStatus(status({ connected: true, status: "connected", email: "o@g.com" }));
    (api.disconnectCalendar as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { disconnected: true }, error: null });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Disconnect Google Calendar?")).toBeInTheDocument();
    expect(api.disconnectCalendar).not.toHaveBeenCalled();
    mockStatus(status());                                                     // the next status read: not connected
    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" }).pop()!);
    await waitFor(() => expect(api.disconnectCalendar).toHaveBeenCalled());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Google Calendar disconnected"));
    await waitFor(() => expect(screen.queryByText("Connected")).not.toBeInTheDocument());
  });

  it("cancelling the disconnect changes nothing", async () => {
    mockStatus(status({ connected: true, status: "connected" }));
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(api.disconnectCalendar).not.toHaveBeenCalled();
  });

  it("a failed disconnect is reported", async () => {
    mockStatus(status({ connected: true, status: "connected" }));
    (api.disconnectCalendar as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: "No calendar is connected." });
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect" }).pop()!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("No calendar is connected."));
  });

  it("status failure shows an error with retry", async () => {
    (api.getCalendarStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: null, error: "Network error" });
    (api.getMyRole as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { is_owner: true }, error: null });
    show();
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
    (api.getCalendarStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: status(), error: null });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(api.getCalendarStatus).toHaveBeenCalledTimes(2);
  });
});

describe("returning from Google", () => {
  it("?calendar=connected shows a success toast once and cleans the address", async () => {
    mockStatus(status({ connected: true, status: "connected", email: "o@g.com" }));
    show("/dashboard/integrations?calendar=connected");
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Google Calendar connected"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/dashboard/integrations"));
    expect(screen.getByTestId("where").textContent).not.toMatch(/calendar=/);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("?calendar=denied says nothing was changed", async () => {
    mockStatus(status());
    show("/dashboard/integrations?calendar=denied");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/cancelled/)));
  });

  it.each([
    ["state", /expired/],
    ["no_refresh", /connected apps/],
    ["reauth", /rejected/],
    ["anything-else", /Couldn't connect/],
  ])("?calendar=error&reason=%s gives a helpful message", async (reason, pattern) => {
    mockStatus(status());
    show(`/dashboard/integrations?calendar=error&reason=${reason}`);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(pattern)));
    await waitFor(() => expect(screen.getByTestId("where").textContent).not.toMatch(/reason=/));
  });

  it("no query string: no toast", async () => {
    mockStatus(status());
    show();
    await waitFor(() => expect(api.getCalendarStatus).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
