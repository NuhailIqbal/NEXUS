import "@/test/radix-stubs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ymd } from "@/lib/callConsumption";

vi.mock("@/services/api", () => ({
  api: { getDashboardOverview: vi.fn(), getDashboardLive: vi.fn(), getMyRole: vi.fn(), pauseCampaign: vi.fn(), resumeCampaign: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// jsdom cannot measure, so Recharts would draw nothing: a stand-in that records what the chart is given.
vi.mock("recharts", () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Box, Area: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
    CartesianGrid: () => null,
    ComposedChart: ({ data }: { data: { label: string; calls: number | null }[] }) => (
      <div data-testid="chart" data-points={data.length} data-labels={data.map((p) => p.label).join("|")} data-calls={data.map((p) => p.calls).join(",")} />
    ),
    AreaChart: ({ data }: { data: unknown[] }) => <div data-testid="spark-chart" data-points={data.length} />,
  };
});

import { toast } from "sonner";
import { api } from "@/services/api";
import { LIVE_REFRESH_MS, customPresets, type DashboardOverview, type LiveData } from "@/lib/dashboardOverview";
import DashboardIndex from "./DashboardIndex";

const getOverview = api.getDashboardOverview as ReturnType<typeof vi.fn>;
const getRole = api.getMyRole as ReturnType<typeof vi.fn>;
const getLive = api.getDashboardLive as ReturnType<typeof vi.fn>;
const pause = api.pauseCampaign as ReturnType<typeof vi.fn>;
const resume = api.resumeCampaign as ReturnType<typeof vi.fn>;

const OK = (data: unknown) => Promise.resolve({ data, error: null });
const FAIL = (error = "boom") => Promise.resolve({ data: null, error });

const trend = (calls = 4) =>
  Array.from({ length: 7 }, (_, i) => ({
    date: `2026-10-${20 + i}`, calls: i === 6 ? calls : 0, qualified_leads: i === 6 ? 1 : 0, leads: i === 6 ? 1 : 0,
    spend: i === 6 ? calls * 0.5 : 0, minutes: i === 6 ? calls : 0, answered: i === 6 ? calls : 0, finished: i === 6 ? calls : 0,
  }));

const liveData = (over: Partial<LiveData> = {}): LiveData => ({
  running_now: { total: 3, outbound: 2, inbound: 1 }, calls_today: { total: 42, answered: 30 }, as_of: "2026-10-26T14:00:00Z", ...over,
});

const overview = (over: Partial<DashboardOverview> = {}): DashboardOverview => ({
  range: "7d", from: "2026-10-20", to: "2026-10-26",
  tiles: {
    has_data: true, has_previous: true,
    calls: { value: 120, previous: 100, change_pct: 20 },
    answered_rate: {
      value: 62.5, answered: 75, finished: 120, previous: 60, change_pts: 2.5,
      not_answered: { total: 45, buckets: { no_answer: 30, busy: 5, voicemail: 6, hung_up: 0, blocked: 0, failed: 4 } },
    },
    qualified_leads: { value: 8, previous: 10, change_pct: -20 },
    leads: { value: 11, previous: 12, change_pct: -8.3 },
    minutes: { value: 95, previous: 80, change_pct: 18.8 },
    spend: { value: 40, previous: 30, change_pct: 33.3 },
    cost_per_qualified_lead: { value: 5, previous: 3, change_pct: 66.7 },
  },
  trend: trend(),
  chart: { granularity: "day", hourly: [] },
  campaigns: {
    counts: { active: 1, paused: 1, inactive: 0 },
    items: [
      { id: "c1", name: "Spring Push", status: "Active", contacts_count: 200, completed_count: 50, state: "dialing", active_now: 3,
        stall_reason: null, warnings: [], errors: 0, last_error: null, waiting_for_hours: false },
      { id: "c2", name: "Listings", status: "Paused", contacts_count: 10, completed_count: 10, state: null, active_now: 0,
        stall_reason: null, warnings: [], errors: 0, last_error: null, waiting_for_hours: false },
    ],
  },
  inventory: { agents: { total: 5, active: 4 }, receptionists: { total: 1, active: 1 } },
  tops: {
    campaigns: [
      { id: "c1", name: "Spring Push", calls: 80, leads: 12, qualified_leads: 9, spend: 45, cost_per_qualified_lead: 5 },
      { id: "c2", name: "Listings with a very long campaign name that must not break the table", calls: 40, leads: 5, qualified_leads: 0, spend: 20, cost_per_qualified_lead: null },
    ],
    agents: [{ id: "a1", name: "Sara", calls: 100, leads: 14, qualified_leads: 10, spend: 60, cost_per_qualified_lead: 6 }],
    receptionists: [{ id: "q1", name: "Front desk", calls: 12, leads: 3, qualified_leads: 2, spend: 6, cost_per_qualified_lead: 3 }],
  },
  recent_calls: [
    { id: "v1", contact_name: "Pat Smith", phone: "+15551234567", status: "Completed", direction: "outbound", duration_seconds: 75,
      call_time: "2026-10-26T14:05:00Z", qualified: true, agent_name: "Sara", campaign_name: "Spring Push" },
    { id: "v2", contact_name: null, phone: "+15557654321", status: "No Answer", direction: "inbound", duration_seconds: 0,
      call_time: "2026-10-26T13:00:00Z", qualified: false, agent_name: "Max", campaign_name: "" },
  ],
  setup: { agent: true, phone: true, campaign: true, receptionist: false, calls: true, complete: true },
  ...over,
});

// The headline number appears in the tiles and (as a count) in the funnel, so wait for it inside the tiles.
const tileValue = async (v: string) => within(await screen.findByTestId("home-tiles")).findByText(v);
const renderPage = () => render(<MemoryRouter><DashboardIndex /></MemoryRouter>);
const tile = (label: string) => within(screen.getByTestId("home-tiles")).getByText(label).closest("div.group") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  getOverview.mockImplementation(() => OK(overview()));
  getLive.mockImplementation(() => OK(liveData()));
  getRole.mockResolvedValue({ data: { is_owner: true }, error: null });
  pause.mockResolvedValue({ data: { status: "Paused" }, error: null });
  resume.mockResolvedValue({ data: { status: "Active" }, error: null });
});

const strip = () => screen.findByTestId("live-strip");
const stripValue = (id: string) => screen.getByTestId(`strip-${id}-value`).textContent;
const stripSub = (id: string) => screen.getByTestId(`strip-${id}-sub`).textContent;

describe("Custom date range", () => {
  const pickCustom = () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Custom" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
  };
  const lastSevenDays = () => {
    const now = new Date();
    return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: ymd(now) };
  };

  it("offers Today, 7 days, 30 days and Custom, and shows the date fields only for Custom", async () => {
    renderPage();
    await tileValue("120");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Today", "7 days", "30 days", "Custom"]);
    expect(screen.queryByTestId("custom-range")).not.toBeInTheDocument();
    pickCustom();
    const box = await screen.findByTestId("custom-range");
    expect(within(box).getByRole("button", { name: "From" })).toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "To" })).toBeInTheDocument();
    // Beside the tabs, in the same row of the header, not in a separate block further down.
    expect(screen.getByRole("tablist").parentElement!.parentElement).toContainElement(box);
  });

  it("asks for the last 7 days when Custom is first chosen, with the dates in the request", async () => {
    renderPage();
    await tileValue("120");
    pickCustom();
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("custom", expect.any(String), lastSevenDays()));
  });

  it("shows the quick picks only for Custom, and picking one fills From / To and asks for exactly those dates", async () => {
    renderPage();
    await tileValue("120");
    expect(screen.queryByTestId("custom-presets")).not.toBeInTheDocument();
    pickCustom();
    const presets = await screen.findByTestId("custom-presets");
    expect(within(presets).getAllByRole("button").map((b) => b.textContent)).toEqual(
      ["Yesterday", "Week to Date", "Month to Date", "Year to Date", "Current Month", "Last Month"]);
    const yesterday = customPresets().find((p) => p.key === "yesterday")!;
    fireEvent.click(within(presets).getByRole("button", { name: "Yesterday" }));
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("custom", expect.any(String), { from: yesterday.from, to: yesterday.to }));
    expect(within(presets).getByRole("button", { name: "Yesterday" })).toHaveAttribute("aria-pressed", "true");
    expect(within(presets).getByRole("button", { name: "Last Month" })).toHaveAttribute("aria-pressed", "false");
  });

  it("each quick pick asks for its own dates", async () => {
    renderPage();
    await tileValue("120");
    pickCustom();
    const presets = await screen.findByTestId("custom-presets");
    for (const p of customPresets()) {
      fireEvent.click(within(presets).getByRole("button", { name: p.label }));
      await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("custom", expect.any(String), { from: p.from, to: p.to }));
    }
  });

  it("names the comparison period by the length of the chosen dates", async () => {
    const o = overview();
    renderPage();
    await tileValue("120");
    getOverview.mockImplementation(() => OK({ ...o, range: "custom", from: "2026-10-10", to: "2026-10-14" }));      // 5 days
    pickCustom();
    expect(await within(tile("Calls made")).findByText("vs the 5 days before")).toBeInTheDocument();
  });

  it("shows what is wrong and does not ask again when a date is cleared", async () => {
    renderPage();
    await tileValue("120");
    pickCustom();
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("custom", expect.any(String), expect.anything()));
    const asked = getOverview.mock.calls.length;
    fireEvent.click(within(await screen.findByTestId("custom-range")).getByRole("button", { name: "From" }));
    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    expect(await screen.findByText("Pick both a start and an end date.")).toBeInTheDocument();
    expect(getOverview.mock.calls.length).toBe(asked);
    expect(within(screen.getByTestId("home-tiles")).getByText("120")).toBeInTheDocument();                     // old numbers stay
  });

  it("goes back to a fixed range without the dates", async () => {
    renderPage();
    await tileValue("120");
    pickCustom();
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("custom", expect.any(String), expect.anything()));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "30 days" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "30 days" }));
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("30d", expect.any(String)));
    expect(screen.queryByTestId("custom-range")).not.toBeInTheDocument();
  });

  it("does not move the live strip", async () => {
    renderPage();
    await waitFor(() => expect(stripValue("today")).toBe("42"));
    pickCustom();
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("custom", expect.any(String), expect.anything()));
    expect(stripValue("today")).toBe("42");
    expect(getLive).toHaveBeenCalledTimes(1);
  });
});

const hourly = (calls: Record<number, number>, upTo = 23) =>
  Array.from({ length: 24 }, (_, h) => ({
    date: "2026-10-27", hour: h,
    calls: h > upTo ? null : (calls[h] ?? 0), qualified_leads: h > upTo ? null : (h === 14 ? 1 : 0), leads: h > upTo ? null : 0,
  }));

describe("Chart granularity", () => {
  const todayOverview = (over: Partial<DashboardOverview["chart"]> = {}, upTo = 15) =>
    overview({ range: "today", chart: { granularity: "hour", hourly: hourly({ 9: 3, 14: 2 }, upTo), ...over } });

  it("draws Today hour by hour: 24 slots, labelled 12 AM ... 11 PM", async () => {
    getOverview.mockImplementation(() => OK(todayOverview()));
    renderPage();
    const chart = await screen.findByTestId("chart");
    expect(chart.getAttribute("data-points")).toBe("24");
    const labels = chart.getAttribute("data-labels")!.split("|");
    expect([labels[0], labels[9], labels[12], labels[23]]).toEqual(["12 AM", "9 AM", "12 PM", "11 PM"]);
    expect(screen.getByText("Each hour, in your time zone.")).toBeInTheDocument();
  });

  it("leaves the hours still to come empty so the line stops at now", async () => {
    getOverview.mockImplementation(() => OK(todayOverview()));
    renderPage();
    const calls = (await screen.findByTestId("chart")).getAttribute("data-calls")!.split(",");
    expect(calls.slice(0, 16)).not.toContain("");                  // up to the current hour: real numbers (0 is real)
    expect(calls.slice(16).every((c) => c === "")).toBe(true);     // after it: nothing, not 0
  });

  it("the legend totals are the hours' sum, which is the range's total", async () => {
    getOverview.mockImplementation(() => OK(todayOverview()));
    renderPage();
    const legend = await screen.findByTestId("trend-legend");
    expect(legend).toHaveTextContent(/Callss*5/);
    expect(legend).toHaveTextContent(/Qualified leadss*1/);
  });

  it("draws 7 and 30 days day by day", async () => {
    renderPage();                                                  // the default fixture is a 7-day overview
    const chart = await screen.findByTestId("chart");
    expect(chart.getAttribute("data-points")).toBe("7");
    expect(chart.getAttribute("data-labels")!.split("|")[0]).toBe("Oct 20");
    expect(screen.getByText("Each day, in your time zone.")).toBeInTheDocument();
  });

  it("a two-day range labels midnight with the date so the days can be told apart", async () => {
    const two = [...hourly({ 5: 1 }).map((p) => ({ ...p, date: "2026-10-26" })), ...hourly({ 8: 2 }, 15)];
    getOverview.mockImplementation(() => OK(overview({ range: "custom", chart: { granularity: "hour", hourly: two } })));
    renderPage();
    const labels = (await screen.findByTestId("chart")).getAttribute("data-labels")!.split("|");
    expect(labels).toHaveLength(48);
    expect(labels[0]).toBe("Oct 26");
    expect(labels[24]).toBe("Oct 27");
    expect(labels[1]).toBe("1 AM");
  });

  it("an hour-by-hour range with no calls says so instead of drawing a flat line", async () => {
    getOverview.mockImplementation(() => OK(overview({ range: "today", chart: { granularity: "hour", hourly: hourly({}, 10) } })));
    renderPage();
    await tileValue("120");
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
    expect(screen.getAllByText("No calls in this period yet.").length).toBeGreaterThan(0);
  });
});

describe("Not answered breakdown", () => {
  const box = async () => within(await screen.findByTestId("not-answered"));

  it("lists why the calls were not answered, biggest first, hiding reasons that did not happen", async () => {
    renderPage();
    const b = await box();
    expect(b.getByText("45")).toBeInTheDocument();                              // the total
    const items = b.getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["No answer 30", "Voicemail 6", "Busy 5", "Failed 4"]);
    expect(b.queryByText(/Hung up/)).not.toBeInTheDocument();
    expect(b.queryByText(/Blocked/)).not.toBeInTheDocument();
  });

  it("marks failed calls as the problem they are, and the rest plainly", async () => {
    renderPage();
    const b = await box();
    expect(b.getByText(/^Failed/).closest("li")!.className).toContain("text-destructive");
    expect(b.getByText(/^No answer/).closest("li")!.className).not.toContain("text-destructive");
  });

  it("names calls that have no result yet, without counting them as not answered", async () => {
    const o = overview();
    getOverview.mockImplementation(() => OK({ ...o, tiles: { ...o.tiles, calls: { ...o.tiles.calls, value: 125 } } }));   // 125 placed, 120 finished
    renderPage();
    const b = await box();
    expect(b.getByText("45")).toBeInTheDocument();
    expect(b.getAllByRole("listitem").map((li) => li.textContent)).toContain("Not finished yet 5");
  });

  it("does not claim 'Not answered 0' when only unfinished calls are left", async () => {
    const o = overview();
    getOverview.mockImplementation(() => OK({
      ...o, tiles: { ...o.tiles, answered_rate: { ...o.tiles.answered_rate, finished: 75, not_answered: { total: 0, buckets: {} } }, calls: { ...o.tiles.calls, value: 78 } },
    }));
    renderPage();
    const b = await box();
    expect(b.getByText("No result yet")).toBeInTheDocument();
    expect(b.queryByText(/Not answered/)).not.toBeInTheDocument();
    expect(b.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Not finished yet 3"]);
  });

  it("is not shown when every finished call was answered or there are no calls", async () => {
    const o = overview();
    getOverview.mockImplementation(() => OK({
      ...o, tiles: { ...o.tiles, answered_rate: { ...o.tiles.answered_rate, finished: 75, not_answered: { total: 0, buckets: {} } }, calls: { ...o.tiles.calls, value: 75 } },
    }));
    const { unmount } = renderPage();
    await screen.findByTestId("funnel");
    expect(screen.queryByTestId("not-answered")).not.toBeInTheDocument();
    unmount();
    getOverview.mockImplementation(() => OK(overview({ tiles: { ...o.tiles, has_data: false, calls: { value: 0, previous: 0, change_pct: null } } })));
    renderPage();
    await screen.findByText("Where your calls go");
    expect(screen.queryByTestId("not-answered")).not.toBeInTheDocument();
  });
});

describe("Top lists", () => {
  const table = async (id: string) => within(await screen.findByTestId(`top-${id}`));

  it("shows the three tables with serial numbers, calls, qualified leads and cost per lead", async () => {
    renderPage();
    const campaigns = await table("campaigns");
    const rows = campaigns.getAllByRole("row");                         // header + 2
    expect(rows).toHaveLength(3);
    const first = within(rows[1]).getAllByRole("cell").map((c) => c.textContent);
    expect(first).toEqual(["1", "Spring Push", "80", "9", "$5.00"]);
    expect(within(rows[2]).getAllByRole("cell")[0]).toHaveTextContent("2");
    expect((await table("agents")).getByText("Sara")).toBeInTheDocument();
    expect((await table("receptionists")).getByText("Front desk")).toBeInTheDocument();
    expect(screen.getByText("Top campaigns")).toBeInTheDocument();
    expect(screen.getByText("Top agents")).toBeInTheDocument();
    expect(screen.getByText("Top inbound receptionists")).toBeInTheDocument();
  });

  it("shows a dash, not $0.00, for cost per lead when nothing qualified", async () => {
    renderPage();
    const rows = (await table("campaigns")).getAllByRole("row");
    expect(within(rows[2]).getAllByRole("cell")[4]).toHaveTextContent("—");
  });

  it("links each name to where it is managed, and keeps a long name to one line with the full name on hover", async () => {
    renderPage();
    expect((await table("campaigns")).getByRole("link", { name: "Spring Push" })).toHaveAttribute("href", "/dashboard/telephony/campaigns");
    expect((await table("agents")).getByRole("link", { name: "Sara" })).toHaveAttribute("href", "/dashboard/ai-agents");
    expect((await table("receptionists")).getByRole("link", { name: "Front desk" })).toHaveAttribute("href", "/dashboard/telephony/inbound");
    const long = (await table("campaigns")).getByRole("link", { name: /Listings with a very long/ });
    expect(long.className).toContain("truncate");
    expect(long).toHaveAttribute("title", expect.stringContaining("must not break the table"));
  });

  it("explains an empty table in words, per table", async () => {
    const o = overview();
    getOverview.mockImplementation(() => OK({ ...o, tops: { campaigns: [], agents: o.tops.agents, receptionists: [] } }));
    renderPage();
    expect(await screen.findByText("No campaign calls in this period.")).toBeInTheDocument();
    expect(screen.getByText("No inbound calls reached a receptionist in this period.")).toBeInTheDocument();
    expect(screen.queryByText("No agent has taken calls in this period.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("top-campaigns")).not.toBeInTheDocument();
  });

  it("follows the range: it shows what the server sent for it", async () => {
    renderPage();
    await tileValue("120");
    const o = overview();
    getOverview.mockImplementation(() => OK({ ...o, range: "7d", tops: { ...o.tops, agents: [{ ...o.tops.agents[0], name: "Max" }] } }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "7 days" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    expect(await (await table("agents")).findByText("Max")).toBeInTheDocument();
  });
});

describe("Right now strip", () => {
  it("shows calls running now with the split, and calls today with how many were answered", async () => {
    renderPage();
    await strip();
    await waitFor(() => expect(stripValue("running")).toBe("3"));
    expect(stripSub("running")).toBe("2 outbound · 1 inbound");
    expect(stripValue("today")).toBe("42");
    expect(stripSub("today")).toBe("30 answered");
    expect(getLive).toHaveBeenCalledWith(expect.any(String));
  });

  it("shows what is set up: agents, outbound campaigns and inbound receptionists", async () => {
    renderPage();
    await waitFor(() => expect(stripValue("agents")).toBe("5"));
    expect(stripSub("agents")).toBe("4 active");
    expect(stripValue("outbound")).toBe("2");                         // 1 active + 1 paused + 0 inactive
    expect(stripSub("outbound")).toBe("1 running");
    expect(stripValue("inbound")).toBe("1");
    expect(stripSub("inbound")).toBe("1 active");
  });

  it("links each count to where it is managed (running now has no link)", async () => {
    renderPage();
    await waitFor(() => expect(stripValue("agents")).toBe("5"));
    expect(screen.getByTestId("strip-agents")).toHaveAttribute("href", "/dashboard/ai-agents");
    expect(screen.getByTestId("strip-outbound")).toHaveAttribute("href", "/dashboard/telephony/campaigns");
    expect(screen.getByTestId("strip-inbound")).toHaveAttribute("href", "/dashboard/telephony/inbound");
    expect(screen.getByTestId("strip-today")).toHaveAttribute("href", "/dashboard/conversations");
    expect(screen.getByTestId("strip-running")).not.toHaveAttribute("href");
  });

  it("says so plainly when nothing is running", async () => {
    getLive.mockImplementation(() => OK(liveData({ running_now: { total: 0, outbound: 0, inbound: 0 } })));
    renderPage();
    await waitFor(() => expect(stripValue("running")).toBe("0"));
    expect(stripSub("running")).toBe("none right now");
  });

  it("does not move when the date range changes: calls today stays today", async () => {
    renderPage();
    await waitFor(() => expect(stripValue("today")).toBe("42"));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "30 days" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "30 days" }));
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("30d", expect.any(String)));
    expect(stripValue("today")).toBe("42");
    expect(getLive).toHaveBeenCalledTimes(1);                          // the range never refetches the live numbers
  });

  it("shows dashes while the numbers have not arrived", async () => {
    getLive.mockImplementation(() => new Promise(() => undefined));
    renderPage();
    await waitFor(() => expect(stripValue("agents")).toBe("5"));
    expect(screen.queryByTestId("strip-running-value")).not.toBeInTheDocument();   // a skeleton, not a fake 0
  });

  describe("polling", () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    it("asks again every few seconds and shows the new number", async () => {
      renderPage();
      await waitFor(() => expect(stripValue("running")).toBe("3"));
      getLive.mockImplementation(() => OK(liveData({ running_now: { total: 7, outbound: 7, inbound: 0 } })));
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS + 100); });
      await waitFor(() => expect(stripValue("running")).toBe("7"));
      expect(getLive.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("keeps the last numbers when a poll fails", async () => {
      renderPage();
      await waitFor(() => expect(stripValue("running")).toBe("3"));
      getLive.mockImplementation(() => FAIL("blip"));
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS + 100); });
      expect(stripValue("running")).toBe("3");
      expect(toast.error).not.toHaveBeenCalled();
    });

    it("does not poll while the tab is hidden, and catches up when it comes back", async () => {
      renderPage();
      await waitFor(() => expect(stripValue("running")).toBe("3"));
      const calls = getLive.mock.calls.length;
      const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS * 3); });
      expect(getLive.mock.calls.length).toBe(calls);
      visibility.mockReturnValue("visible");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(getLive.mock.calls.length).toBe(calls + 1);
      visibility.mockRestore();
    });

    it("stops polling when the page is left", async () => {
      const { unmount } = renderPage();
      await waitFor(() => expect(stripValue("running")).toBe("3"));
      unmount();
      const calls = getLive.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS * 3); });
      expect(getLive.mock.calls.length).toBe(calls);
    });
  });
});

describe("Dashboard home", () => {
  it("opens on Today, in the viewer's time zone, and shows the six headline tiles with their change", async () => {
    renderPage();
    await tileValue("120");
    expect(getOverview).toHaveBeenCalledWith("today", expect.any(String));
    expect(screen.getByRole("tab", { name: "Today" })).toHaveAttribute("data-state", "active");
    expect(within(tile("Calls made")).getByText("20.0%")).toBeInTheDocument();
    expect(within(tile("Calls made")).getByText("vs yesterday")).toBeInTheDocument();
    expect(within(tile("Answered rate")).getByText("62.5%")).toBeInTheDocument();
    expect(within(tile("Answered rate")).getByText("2.5 pts")).toBeInTheDocument();
    expect(within(tile("Qualified leads")).getByText("8")).toBeInTheDocument();
    expect(within(tile("Talk time")).getByText("1h 35m")).toBeInTheDocument();
    expect(within(tile("Spend")).getByText("$40.00")).toBeInTheDocument();
    expect(within(tile("Cost per qualified lead")).getByText("$5.00")).toBeInTheDocument();
  });

  it("switching the range refetches it and keeps the old numbers up while it loads", async () => {
    renderPage();
    await tileValue("120");
    let release: (v: unknown) => void = () => undefined;
    getOverview.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "7 days" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "7 days" }));
    await waitFor(() => expect(getOverview).toHaveBeenLastCalledWith("7d", expect.any(String)));
    expect(within(screen.getByTestId("home-tiles")).getByText("120")).toBeInTheDocument();                           // still there, dimmed
    release({ data: overview({ range: "7d", tiles: { ...overview().tiles, calls: { value: 7, previous: 5, change_pct: 40 } } }), error: null });
    await tileValue("7");
    expect(within(screen.getByTestId("home-tiles")).queryByText("120")).not.toBeInTheDocument();
  });

  it("colours a change by whether it is good news: cost going up is red, calls going up is green", async () => {
    renderPage();
    await tileValue("120");
    const pill = (label: string, text: string) => within(tile(label)).getByText(text).closest("span")!;
    expect(pill("Calls made", "20.0%").className).toContain("text-success");
    expect(pill("Cost per qualified lead", "66.7%").className).toContain("text-destructive");   // up, but it is a cost: bad
    expect(pill("Spend", "33.3%").className).toContain("text-destructive");
    expect(pill("Qualified leads", "20.0%").className).toContain("text-destructive");          // -20%: down, bad
  });

  it("gives every tile a sparkline of the days", async () => {
    renderPage();
    await tileValue("120");
    for (const id of ["calls", "answered", "qualified", "minutes", "spend", "cpql"]) {
      expect(screen.getByTestId(`spark-${id}`).getAttribute("data-points")).toBe("7");
    }
  });

  it("greets the viewer", async () => {
    renderPage();
    await tileValue("120");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toMatch(/^Good (morning|afternoon|evening)/);
  });

  it("shows where calls go as a funnel with counts and shares", async () => {
    renderPage();
    const funnel = await screen.findByTestId("funnel");
    expect(within(funnel).getByText("Calls made")).toBeInTheDocument();
    expect(within(funnel).getByText("75")).toBeInTheDocument();             // answered
    expect(within(funnel).getByText("62.5%")).toBeInTheDocument();          // 75 of 120 calls
    expect(within(funnel).getByText("Qualified")).toBeInTheDocument();
    expect(within(funnel).getByText("6.7%")).toBeInTheDocument();           // 8 of 120
  });

  it("shows the trend with every day it is given", async () => {
    renderPage();
    expect((await screen.findByTestId("chart")).getAttribute("data-points")).toBe("7");
  });

  it("says so when there are no calls in the period, and shows dashes instead of fake zeros for ratios", async () => {
    getOverview.mockImplementation(() => OK(overview({
      tiles: {
        has_data: false, has_previous: false,
        calls: { value: 0, previous: 0, change_pct: null },
        answered_rate: { value: null, answered: 0, finished: 0, previous: null, change_pts: null, not_answered: { total: 0, buckets: {} } },
        qualified_leads: { value: 0, previous: 0, change_pct: null }, leads: { value: 0, previous: 0, change_pct: null },
        minutes: { value: 0, previous: 0, change_pct: null }, spend: { value: 0, previous: 0, change_pct: null },
        cost_per_qualified_lead: { value: null, previous: null, change_pct: null },
      },
      trend: trend(0), recent_calls: [],
    })));
    renderPage();
    await screen.findByText("No calls in this period");
    expect(within(tile("Answered rate")).getByText("—")).toBeInTheDocument();
    expect(within(tile("Cost per qualified lead")).getByText("—")).toBeInTheDocument();
    expect(screen.getAllByText("No calls in this period yet.")).toHaveLength(2);              // the chart and the funnel
    expect(screen.getByText(/No conversations yet/)).toBeInTheDocument();
    expect(screen.queryByTestId("chart")).not.toBeInTheDocument();
  });

  it("shows no change when the period before had nothing to compare", async () => {
    const o = overview();
    getOverview.mockImplementation(() => OK({ ...o, tiles: { ...o.tiles, has_previous: false } }));
    renderPage();
    await tileValue("120");
    expect(screen.queryByText(/vs yesterday/)).not.toBeInTheDocument();
  });

  describe("campaigns", () => {
    it("lists them with status and progress", async () => {
      renderPage();
      const list = await screen.findByTestId("campaign-list");
      expect(within(list).getByText("Spring Push")).toBeInTheDocument();
      expect(within(list).getByText("50 / 200 reached")).toBeInTheDocument();
      expect(within(list).getByText("3 calls in progress.")).toBeInTheDocument();
      expect(within(list).getByText("Paused.")).toBeInTheDocument();
      expect(screen.getByText("1 active, 1 paused")).toBeInTheDocument();
    });
    it("pauses an active campaign and refreshes", async () => {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Pause Spring Push" }));
      await waitFor(() => expect(pause).toHaveBeenCalledWith("c1"));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Spring Push paused."));
      await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));
    });
    it("resumes a paused campaign", async () => {
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Resume Listings" }));
      await waitFor(() => expect(resume).toHaveBeenCalledWith("c2"));
    });
    it("reports a failed pause and does not claim success", async () => {
      pause.mockResolvedValue({ data: null, error: "Nope" });
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Pause Spring Push" }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Nope"));
      expect(toast.success).not.toHaveBeenCalled();
    });
    it("hides pause / resume from Viewers, who still see the campaigns", async () => {
      getRole.mockResolvedValue({ data: { is_owner: false, role: "viewer" }, error: null });
      renderPage();
      await screen.findByTestId("campaign-list");
      await waitFor(() => expect(getRole).toHaveBeenCalled());
      expect(screen.queryByRole("button", { name: /^(Pause|Resume) / })).not.toBeInTheDocument();
    });
    it("keeps pause / resume for team Members", async () => {
      getRole.mockResolvedValue({ data: { is_owner: false, role: "member" }, error: null });
      renderPage();
      expect(await screen.findByRole("button", { name: "Pause Spring Push" })).toBeInTheDocument();
    });
    it("explains an empty list", async () => {
      const o = overview();
      getOverview.mockImplementation(() => OK({ ...o, campaigns: { counts: { active: 0, paused: 0, inactive: 2 }, items: [] } }));
      renderPage();
      expect(await screen.findByText("No active campaigns yet.")).toBeInTheDocument();
    });
  });

  it("lists recent conversations that link to the Conversations page", async () => {
    renderPage();
    const list = await screen.findByTestId("recent-calls");
    expect(within(list).getByText("Pat Smith")).toBeInTheDocument();
    expect(within(list).getByText("Qualified")).toBeInTheDocument();
    expect(within(list).getByText("1:15")).toBeInTheDocument();
    expect(within(list).getByText("+15557654321")).toBeInTheDocument();             // no name: the number
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/dashboard/conversations");
  });

  describe("needs attention", () => {
    it("is absent when all is well", async () => {
      renderPage();
      await tileValue("120");
      expect(screen.queryByTestId("attention-list")).not.toBeInTheDocument();
    });
    it("lists a stalled campaign and one with call errors, each with a link, and ignores a paused one", async () => {
      const o = overview();
      getOverview.mockImplementation(() => OK({
        ...o,
        campaigns: { ...o.campaigns, items: [
          { ...o.campaigns.items[0], stall_reason: "provider_error" },
          { ...o.campaigns.items[0], id: "c3", name: "Third", errors: 2, last_error: "VAPI said no" },
          { ...o.campaigns.items[1], stall_reason: "balance" },
        ] },
      }));
      renderPage();
      const list = await screen.findByTestId("attention-list");
      const alerts = within(list).getAllByRole("alert");
      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toHaveTextContent("Spring Push: Stopped after repeated call errors");
      expect(alerts[1]).toHaveTextContent("Third: some calls could not be placed (voice service said no)");
      expect(within(alerts[0]).getByRole("link")).toHaveAttribute("href", "/dashboard/telephony/campaigns");
    });
  });

  describe("new account", () => {
    const fresh = () => overview({
      setup: { agent: false, phone: false, campaign: false, receptionist: false, calls: false, complete: false },
      tiles: { ...overview().tiles, has_data: false, has_previous: false },
      recent_calls: [], campaigns: { counts: { active: 0, paused: 0, inactive: 0 }, items: [] },
    });
    it("shows the first steps with a way into Quick Setup", async () => {
      getOverview.mockImplementation(() => OK(fresh()));
      renderPage();
      const card = await screen.findByTestId("setup-checklist");
      expect(within(card).getByText("0 of 3 first steps done.", { exact: false })).toBeInTheDocument();
      expect(within(card).getByRole("link", { name: "Create an AI agent" })).toHaveAttribute("href", "/dashboard/ai-agents/create");
      expect(within(card).getByRole("link", { name: "All setup steps" })).toHaveAttribute("href", "/dashboard/quick-setup");
    });
    it("ticks off what is done", async () => {
      const o = fresh();
      getOverview.mockImplementation(() => OK({ ...o, setup: { ...o.setup, agent: true, phone: true } }));
      renderPage();
      const card = await screen.findByTestId("setup-checklist");
      expect(within(card).getByText("2 of 3 first steps done.", { exact: false })).toBeInTheDocument();
      expect(within(card).getByRole("link", { name: "Create an AI agent (done)" })).toBeInTheDocument();
      expect(within(card).getByRole("link", { name: "Start calling" })).toBeInTheDocument();
    });
    it("is not shown once the account is ready", async () => {
      renderPage();
      await tileValue("120");
      expect(screen.queryByTestId("setup-checklist")).not.toBeInTheDocument();
    });
  });

  describe("failures", () => {
    it("shows an error with Retry when the first load fails, and recovers", async () => {
      getOverview.mockImplementationOnce(() => FAIL("Could not reach the server"));
      renderPage();
      expect(await screen.findByText("Could not reach the server")).toBeInTheDocument();
      expect(toast.error).toHaveBeenCalledWith("Could not reach the server");
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(await tileValue("120")).toBeInTheDocument();
      expect(screen.queryByText("Could not reach the server")).not.toBeInTheDocument();
    });
    it("survives a request that throws", async () => {
      getOverview.mockImplementationOnce(() => Promise.reject(new Error("offline")));
      renderPage();
      expect(await screen.findByText("Failed to load the dashboard. Please try again.")).toBeInTheDocument();
    });
    it("keeps the numbers when only a later refresh fails", async () => {
      renderPage();
      await tileValue("120");
      getOverview.mockImplementationOnce(() => FAIL("blip"));
      fireEvent.click(await screen.findByRole("button", { name: "Pause Spring Push" }));      // triggers a quiet refresh
      await waitFor(() => expect(getOverview).toHaveBeenCalledTimes(2));
      expect(within(screen.getByTestId("home-tiles")).getByText("120")).toBeInTheDocument();
      expect(screen.queryByText("blip")).not.toBeInTheDocument();
    });
  });

  it("never mentions the voice vendor", async () => {
    renderPage();
    await tileValue("120");
    expect(document.body.textContent?.toLowerCase()).not.toContain("vapi");
  });
});
