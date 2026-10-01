import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CalendarConnectSteps } from "./CalendarConnectSteps";
import type { CalendarStatus } from "./calendarTypes";

const settings = {
  timezone: "UTC", work_days: [0, 1, 2, 3, 4], start_time: "09:00", end_time: "17:00",
  slot_minutes: 30, buffer_minutes: 0, min_notice_hours: 2, max_days_ahead: 30,
};
const REDIRECT = "https://api.example.com/calendar/google/callback";
const status = (over: Partial<CalendarStatus> = {}): CalendarStatus => ({
  configured: true, redirect_uri: REDIRECT, connected: false, status: null, email: null, settings, ...over,
});
const show = (over: { status?: CalendarStatus | null; loading?: boolean; error?: string | null; isOwner?: boolean; onRetry?: () => void } = {}) =>
  render(<CalendarConnectSteps status={over.status === undefined ? status() : over.status} loading={over.loading ?? false}
    error={over.error ?? null} isOwner={over.isOwner ?? true} onRetry={over.onRetry ?? vi.fn()} />);

beforeEach(() => vi.clearAllMocks());

describe("CalendarConnectSteps", () => {
  it("loading", () => {
    show({ loading: true, status: null });
    expect(screen.getByText(/Checking calendar setup/)).toBeInTheDocument();
  });

  it("error with a working retry", () => {
    const onRetry = vi.fn();
    show({ error: "boom", status: null, onRetry });
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("no status and no error still shows a retry, never a blank box", () => {
    show({ status: null });
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't load/);
  });

  describe("ready to connect", () => {
    it("explains the three steps and what NEXUS can and cannot see", () => {
      show();
      expect(screen.getByText(/Connect with Google/)).toBeInTheDocument();
      expect(screen.getByText(/when you're busy/)).toBeInTheDocument();
      expect(screen.getByText(/never reads your event titles or details/)).toBeInTheDocument();
      expect(screen.getByText(/Check Availability/)).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(3);
    });
    it("does not show the server setup steps", () => {
      show();
      expect(screen.queryByText(/One-time setup needed/)).not.toBeInTheDocument();
      expect(screen.queryByText(REDIRECT)).not.toBeInTheDocument();
    });
  });

  describe("server not set up for Google yet", () => {
    it("shows the five setup steps with links, the exact redirect address and the env names", () => {
      show({ status: status({ configured: false }) });
      expect(screen.getByText(/One-time setup needed first/)).toBeInTheDocument();
      expect(screen.getAllByRole("listitem")).toHaveLength(5);
      expect(screen.getByRole("link", { name: /Google Cloud Console/ })).toHaveAttribute("href", expect.stringContaining("console.cloud.google.com"));
      expect(screen.getByRole("link", { name: /Google Calendar API/ })).toHaveAttribute("href", expect.stringContaining("calendar-json.googleapis.com"));
      expect(screen.getByLabelText("redirect URI")).toHaveTextContent(REDIRECT);
      expect(screen.getByText("GOOGLE_CLIENT_ID")).toBeInTheDocument();
      expect(screen.getByText("GOOGLE_CLIENT_SECRET")).toBeInTheDocument();
      expect(screen.getByText("calendar.events")).toBeInTheDocument();
      expect(screen.getByText("calendar.freebusy")).toBeInTheDocument();
    });
    it("every external link opens in a new tab safely", () => {
      show({ status: status({ configured: false }) });
      for (const a of screen.getAllByRole("link")) {
        expect(a).toHaveAttribute("target", "_blank");
        expect(a.getAttribute("rel")).toContain("noreferrer");
      }
    });
    it("the copy button copies the redirect address", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });
      show({ status: status({ configured: false }) });
      fireEvent.click(screen.getByRole("button", { name: "Copy redirect URI" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(REDIRECT));
    });
    it("a blocked clipboard does not crash", async () => {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
      show({ status: status({ configured: false }) });
      fireEvent.click(screen.getByRole("button", { name: "Copy redirect URI" }));
      await waitFor(() => expect(screen.getByLabelText("redirect URI")).toBeInTheDocument());
    });
  });

  describe("already connected", () => {
    it("says so with the account", () => {
      show({ status: status({ connected: true, status: "connected", email: "o@g.com" }) });
      expect(screen.getByText(/already connected as o@g.com/)).toBeInTheDocument();
      expect(screen.getByText(/Calendar section on this page/)).toBeInTheDocument();
    });
    it("connected without a known email still reads well", () => {
      show({ status: status({ connected: true, status: "connected", email: null }) });
      expect(screen.getByText(/already connected$/)).toBeInTheDocument();
    });
    it("an expired connection asks to reconnect and promises settings are kept", () => {
      show({ status: status({ connected: true, status: "reauth_required" }) });
      expect(screen.getByText(/needs to be reconnected/)).toBeInTheDocument();
      expect(screen.getByText(/settings are kept/)).toBeInTheDocument();
    });
  });

  it("non-owners are told to ask the owner", () => {
    show({ isOwner: false });
    expect(screen.getByText(/Only the account owner can connect a calendar/)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("a non-owner also does not see server setup steps", () => {
    show({ isOwner: false, status: status({ configured: false }) });
    expect(screen.queryByText(/One-time setup needed/)).not.toBeInTheDocument();
  });
});
