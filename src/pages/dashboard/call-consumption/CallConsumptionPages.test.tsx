import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

vi.mock("@/services/api", () => ({ api: { getCallConsumption: vi.fn(), downloadCallConsumption: vi.fn() } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("react-apexcharts", () => import("@/test/apexchartsStub"));

import { toast } from "sonner";
import { api } from "@/services/api";
import { apexCalls, lastApexCall } from "@/test/apexchartsStub";
import { choose } from "@/test/pick";
import { periodPresets } from "@/lib/callConsumption";
import CallConsumptionOverview from "./Overview";
import { CallConsumptionCampaign, CallConsumptionState, CallConsumptionVertical } from "./Breakdown";
import CallConsumptionHourly from "./HourlyHeatmap";
import CallConsumptionReasons from "./NonConsumptionReasons";
import CallConsumptionPeriodic from "./Periodic";
import CallConsumptionDirectionPage from "./InboundOutbound";

const get = api.getCallConsumption as ReturnType<typeof vi.fn>;
const download = api.downloadCallConsumption as ReturnType<typeof vi.fn>;

const buckets = (over = {}) => ({ no_answer: 0, busy: 0, voicemail: 0, hung_up: 0, blocked: 0, failed: 0, ...over });
const tally = (total: number, dropped: number, over = {}) => ({
  total_calls: total, consumed_calls: total - dropped, consumption_pct: +(((total - dropped) / total) * 100).toFixed(2),
  dropped_calls: dropped, drop_pct: +((dropped / total) * 100).toFixed(2), buckets: buckets({ failed: dropped }), dropped_cost: 0.7, ...over,
});

const OK = (data: unknown) => Promise.resolve({ data, error: null });
const FAIL = (error = "boom") => Promise.resolve({ data: null, error });

const options = { states: [{ code: "CO", name: "Colorado" }, { code: "NY", name: "New York" }], campaigns: [{ id: "c1", name: "Spring Push" }], agents: [{ id: "a1", name: "Sara" }], verticals: ["Insurance"],
  dispositions: [{ value: "consumed", label: "Consumed" }, { value: "failed", label: "Failed" }] };

const summary = {
  has_data: true,
  rows: [{ name: "March 2026", start_date: "2026-03-02", end_date: "2026-03-06", ...tally(17, 7),
    children: [{ name: "Week of Mar 2", ...tally(17, 7), children: [{ name: "2026-03-02", ...tally(10, 2) }] }] }],
  total: { name: "Total", ...tally(17, 7) },
};

const insights = [
  { category: "Worst Vertical", badge: "WORST VERTICAL", title: "Insurance is now the worst vertical at 40.0% drop.", description: "6 of 15", action_label: "Action", action: "Review the script." },
  { category: "Trend", badge: "DECLINING", title: "Legal traffic declined by 40%.", description: "d", action_label: null, action: null },
];
const hotspots = [
  { dimension: "Hour", row_type: "Worst", segment: "10:00 AM", segment_sub_label: "Mon Mar 2", calls: 10, dropped: 2, drop_rate_pct: 20 },
  { dimension: "State", row_type: "Best", segment: "Colorado", segment_sub_label: null, calls: 14, dropped: 0, drop_rate_pct: 0 },
];
const dsum = (total: number, dropped: number) => ({ has_data: total > 0, total_calls: total, consumed_calls: total - dropped, dropped_calls: dropped,
  consumption_pct: total ? +(((total - dropped) / total) * 100).toFixed(1) : 0, drop_pct: total ? +((dropped / total) * 100).toFixed(1) : 0 });
const directions = { outbound: dsum(16, 7), inbound: dsum(7, 3) };
const kpis = { has_data: true, has_previous: true, total_calls: 17, total_calls_change_pct: -88.2, consumption_pct: 58.8, consumption_pct_point_change: 4.1, drop_pct: 41.2, drop_pct_point_change: -4.1 };

type Handler = (params: Record<string, string | undefined>) => Promise<unknown>;
let handlers: Record<string, Handler>;

function setupHandlers(over: Record<string, Handler> = {}) {
  handlers = {
    "/filters": () => OK(options),
    "/overview/kpis": () => OK(kpis),
    "/overview/summary": () => OK(summary),
    "/overview/insights": () => OK(insights),
    "/overview/hotspots": () => OK(hotspots),
    "/overview/directions": () => OK(directions),
    ...over,
  };
  get.mockImplementation((path: string, params: Record<string, string | undefined> = {}) =>
    handlers[path] ? handlers[path](params) : FAIL(`unmocked ${path}`));
}

/** Open a date field's calendar popup and click a day of the month it shows (optionally after moving to the next month). */
function pickDay(label: string, day: string, nextMonth = false) {
  if (!screen.queryByRole("button", { name: label })) fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
  fireEvent.click(screen.getByRole("button", { name: label }));
  const dialog = screen.getByRole("dialog");
  if (nextMonth) fireEvent.click(within(dialog).getByRole("button", { name: /next month/i }));
  const cell = within(dialog).getAllByText(day).find((c) => !c.className.includes("day-outside"))!;
  fireEvent.click(cell);
}

const calls = (path: string) => get.mock.calls.filter((c) => c[0] === path);
const Where = () => { const l = useLocation(); return <div data-testid="where">{l.pathname}{l.search}</div>; };

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/dashboard/call-consumption/overview" element={<CallConsumptionOverview />} />
        <Route path="/dashboard/call-consumption/campaign" element={<CallConsumptionCampaign />} />
        <Route path="/dashboard/call-consumption/state" element={<CallConsumptionState />} />
        <Route path="/dashboard/call-consumption/vertical" element={<CallConsumptionVertical />} />
        <Route path="/dashboard/call-consumption/periodic" element={<CallConsumptionPeriodic />} />
        <Route path="/dashboard/call-consumption/direction" element={<CallConsumptionDirectionPage />} />
        <Route path="/dashboard/call-consumption/hourly-heatmap" element={<CallConsumptionHourly />} />
        <Route path="/dashboard/call-consumption/reasons" element={<><CallConsumptionReasons /><Where /></>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => { vi.clearAllMocks(); apexCalls.length = 0; setupHandlers(); });

describe("Overview", () => {
  it("loads four independent widgets and shows their data", async () => {
    renderAt("/dashboard/call-consumption/overview");
    expect(await screen.findByText("March 2026")).toBeInTheDocument();
    expect(screen.getByText("41.2%")).toBeInTheDocument();
    expect(screen.getByText("58.8%")).toBeInTheDocument();
    expect(screen.getByText("-88.2% vs previous period")).toBeInTheDocument();
    expect(screen.getByText(/Insurance is now the worst vertical/)).toBeInTheDocument();
    expect(screen.getByText("Colorado")).toBeInTheDocument();
    expect(screen.queryByTestId("section-loading")).toBeNull();
    for (const p of ["/overview/kpis", "/overview/summary", "/overview/insights", "/overview/hotspots"]) expect(calls(p)).toHaveLength(1);
  });

  it("colours a falling drop rate as good news and a falling consumption rate as bad", async () => {
    renderAt("/dashboard/call-consumption/overview");
    const drop = await screen.findByText("-4.1 pts vs previous period");
    expect(drop.className).toContain("text-success");            // drop rate fell: good
    expect(screen.getByText("+4.1 pts vs previous period").className).toContain("text-success"); // consumption rose: good
    expect(screen.getByText("-88.2% vs previous period").className).toContain("text-destructive"); // volume fell: bad
  });

  it("says so instead of inventing a change when the previous period had no calls", async () => {
    setupHandlers({ "/overview/kpis": () => OK({ ...kpis, has_previous: false, total_calls_change_pct: 0, consumption_pct_point_change: 0, drop_pct_point_change: 0 }) });
    renderAt("/dashboard/call-consumption/overview");
    expect(await screen.findAllByText("No calls in the previous period to compare")).toHaveLength(3);
    expect(screen.queryByText(/pts vs previous period/)).toBeNull();
    expect(screen.queryByText(/% vs previous period/)).toBeNull();
    expect(screen.getByText("41.2%")).toBeInTheDocument();
  });

  it("one widget failing shows its own error and toast while the rest still render", async () => {
    setupHandlers({ "/overview/insights": () => FAIL("Insights are down") });
    renderAt("/dashboard/call-consumption/overview");
    expect(await screen.findByText("Insights are down")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("March 2026")).toBeInTheDocument();
    expect(screen.getByText("Colorado")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("Insights are down");
    expect(screen.queryByTestId("section-loading")).toBeNull(); // the spinner stopped
  });

  it("a thrown request (network or 500) also stops the spinner and shows a message", async () => {
    setupHandlers({ "/overview/hotspots": () => Promise.reject(new Error("socket hang up")) });
    renderAt("/dashboard/call-consumption/overview");
    expect(await screen.findByText("Failed to load the hotspots. Please try again.")).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith("Failed to load the hotspots. Please try again.");
    expect(screen.queryByTestId("section-loading")).toBeNull();
    expect(screen.getByText("March 2026")).toBeInTheDocument();
  });

  it("Retry reloads only the failed widget", async () => {
    let n = 0;
    setupHandlers({ "/overview/insights": () => (++n === 1 ? FAIL("nope") : OK(insights)) });
    renderAt("/dashboard/call-consumption/overview");
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/Insurance is now the worst vertical/)).toBeInTheDocument();
    expect(calls("/overview/insights")).toHaveLength(2);
    expect(calls("/overview/summary")).toHaveLength(1);
  });

  it("shows No Data Found and disables the export when there is nothing", async () => {
    setupHandlers({
      "/overview/kpis": () => OK({ ...kpis, has_data: false, total_calls: 0 }),
      "/overview/summary": () => OK({ has_data: false, rows: [], total: { name: "Total", ...tally(1, 0, { total_calls: 0, consumed_calls: 0, dropped_calls: 0, drop_pct: 0, consumption_pct: 0 }) } }),
      "/overview/insights": () => OK([{ category: "Performance", badge: "NO DATA", title: "No operational insights are available for the selected filters.", description: "x", action_label: null, action: null }]),
      "/overview/hotspots": () => OK([]),
    });
    renderAt("/dashboard/call-consumption/overview");
    await waitFor(() => expect(screen.getAllByText("No Data Found").length).toBeGreaterThanOrEqual(3));
    for (const b of screen.getAllByRole("button", { name: /export csv/i })) expect(b).toBeDisabled();
  });

  it("only refetches when Search is pressed, and sends the new dates", async () => {
    renderAt("/dashboard/call-consumption/overview");
    await screen.findByText("March 2026");
    pickDay("From", "10");
    expect(calls("/overview/summary")).toHaveLength(1); // choosing a date alone does nothing
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(calls("/overview/summary")).toHaveLength(2));
    expect(calls("/overview/summary")[1][1]).toMatchObject({ from: expect.stringMatching(/-10$/) });
    for (const p of ["/overview/kpis", "/overview/insights", "/overview/hotspots"]) expect(calls(p)).toHaveLength(2);
  });

  it("blocks Search on a backwards date range and says why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 15));
    try {
      renderAt("/dashboard/call-consumption/overview");
      await screen.findByText("March 2026");
      pickDay("To", "15");
      pickDay("From", "28"); // From = Mar 28, To = Mar 15
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("alert")).toHaveTextContent(/on or before/i);
    expect(screen.getByRole("button", { name: /search/i })).toBeDisabled();
  });

  it("Clear puts the default range back and refetches", async () => {
    renderAt("/dashboard/call-consumption/overview");
    await screen.findByText("March 2026");
    pickDay("From", "10");
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(calls("/overview/summary")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(calls("/overview/summary")).toHaveLength(3));
    expect(calls("/overview/summary")[2][1].from).toBeUndefined(); // back to nothing selected
  });

  it("ignores a slow answer to an old search once a newer one is in", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    setupHandlers({
      "/overview/summary": () => new Promise((res) => { resolvers.push(res); }),
    });
    renderAt("/dashboard/call-consumption/overview");
    await waitFor(() => expect(resolvers).toHaveLength(1));
    pickDay("From", "10");
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    const named = (name: string) => ({ data: { ...summary, rows: [{ ...summary.rows[0], name }] }, error: null });
    await act(async () => { resolvers[1](named("NEW RESULT")); });
    expect(await screen.findByText("NEW RESULT")).toBeInTheDocument();
    await act(async () => { resolvers[0](named("OLD RESULT")); });
    expect(screen.queryByText("OLD RESULT")).toBeNull();
    expect(screen.getByText("NEW RESULT")).toBeInTheDocument();
  });

  it("exports through the authenticated download and reports a refusal", async () => {
    download.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: "There is no data to export for these filters." });
    renderAt("/dashboard/call-consumption/overview");
    await screen.findByText("March 2026");
    const [summaryExport] = screen.getAllByRole("button", { name: /export csv/i });
    fireEvent.click(summaryExport);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0][0]).toBe("/overview/export/summary.csv");
    expect(download.mock.calls[0][2]).toBe("CallConsumptionOverviewSummary.csv");
    expect(download.mock.calls[0][1]).toMatchObject({ tz: expect.any(String) });
    expect(toast.error).not.toHaveBeenCalled();
    fireEvent.click(summaryExport);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("There is no data to export for these filters."));
  });
});

describe("Campaign page", () => {
  const combo = [{ key: "c1", name: "Spring Push", ...tally(14, 6) }, { key: "", name: "No campaign", ...tally(1, 0) }];
  const bd = (over: Record<string, Handler> = {}) => setupHandlers({
    "/breakdown/campaign/kpi": () => OK({ has_data: true, total_calls: 15, consumed_calls: 9, consumed_pct: 60, dropped_calls: 6, dropped_pct: 40, segment_count: 2,
      worst_segment_name: "Spring Push", worst_segment_drop_rate: 42.9, worst_segment_calls: 14, cost_on_dropped: 0.6 }),
    "/breakdown/campaign/combo": () => OK(combo),
    "/breakdown/campaign/disposition": () => OK([{ key: "c1", name: "Spring Push", disposition: "failed", label: "Failed", calls: 4 }]),
    "/breakdown/campaign/mix": () => OK([{ disposition: "failed", label: "Failed", calls: 4, pct_of_dropped: 100 }]),
    "/breakdown/campaign/ranking": () => OK([{ key: "c1", name: "Spring Push", total_calls: 14, dropped_calls: 6, drop_rate_pct: 42.9 }]),
    "/breakdown/campaign/summary": () => OK({ has_data: true, rows: [{ key: "c1", name: "Spring Push", ...tally(14, 6) }, { key: "", name: "No campaign", ...tally(1, 0) }], total: { name: "Total", ...tally(15, 6) } }),
    ...over,
  });

  it("fires six independent requests and fills the headline numbers", async () => {
    bd();
    renderAt("/dashboard/call-consumption/campaign");
    expect(await screen.findByText("Worst campaign")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("42.9% dropped · 14 calls")).toBeInTheDocument());
    expect(screen.getByText("$0.60")).toBeInTheDocument();
    for (const s of ["kpi", "combo", "disposition", "mix", "ranking", "summary"]) expect(calls(`/breakdown/campaign/${s}`)).toHaveLength(1);
  });

  it("clicking a campaign opens its reasons (carrying any chosen dates and the time zone)", async () => {
    bd();
    renderAt("/dashboard/call-consumption/campaign");
    const table = (await screen.findByText("Summary")).closest("section")!;
    fireEvent.click(await within(table).findByText("Spring Push"));
    await waitFor(() => expect(screen.getAllByTestId("where")[0].textContent).toMatch(/^\/dashboard\/call-consumption\/reasons\?campaign_id=c1&tz=/));
  });

  it("a row with no campaign (inbound / one-off) is not a link", async () => {
    bd();
    renderAt("/dashboard/call-consumption/campaign");
    const table = (await screen.findByText("Summary")).closest("section")!;
    fireEvent.click(await within(table).findByText("No campaign"));
    expect(screen.getAllByTestId("where")[0].textContent).toMatch(/campaign$/);
  });

  it("hands each section to the right kind of Apex chart", async () => {
    bd();
    renderAt("/dashboard/call-consumption/campaign");
    await waitFor(() => expect(screen.getAllByTestId("apex-chart")).toHaveLength(4));
    expect(screen.getAllByTestId("apex-chart").map((c) => c.getAttribute("data-type")).sort()).toEqual(["area", "bar", "bar", "donut"]);
    // Combo: fixed 350px, no toolbar. Stacked: its own width, inside a sideways-scrolling card.
    expect(lastApexCall("area")).toMatchObject({ height: 350, options: { chart: { zoom: { enabled: false }, toolbar: { show: false } } } });
    expect(screen.getByTestId("stacked-scroll")).toBeInTheDocument();
    expect(screen.getByTestId("ranking-scroll")).toBeInTheDocument();
    const bars = apexCalls.filter((c) => c.type === "bar");
    expect(bars.some((c) => c.options?.chart?.stacked === true && c.width === "100%")).toBe(true); // fills the card
    expect(bars.some((c) => c.options?.plotOptions?.bar?.horizontal === true && c.height === 350)).toBe(true); // 1 bar -> the 350px floor
  });

  it("clicking a campaign's label in the ranking chart opens its reasons, but a 0% or id-less row does nothing", async () => {
    bd({ "/breakdown/campaign/ranking": () => OK([
      { key: "c1", name: "Spring Push", total_calls: 14, dropped_calls: 6, drop_rate_pct: 42.9 },
      { key: "c2", name: "Clean one", total_calls: 9, dropped_calls: 0, drop_rate_pct: 0 },
      { key: "", name: "No campaign", total_calls: 3, dropped_calls: 2, drop_rate_pct: 66.7 },
    ]) });
    renderAt("/dashboard/call-consumption/campaign");
    await waitFor(() => expect(apexCalls.some((c) => c.options?.plotOptions?.bar?.horizontal)).toBe(true));
    const ranking = [...apexCalls].reverse().find((c) => c.options?.plotOptions?.bar?.horizontal)!;
    const events = ranking.options!.chart.events;
    events.xAxisLabelClick({}, {}, { labelIndex: 1 });   // 0% drop rate
    events.xAxisLabelClick({}, {}, { labelIndex: 2 });   // no campaign id
    events.xAxisLabelClick({}, {}, { labelIndex: 9 });   // out of range
    expect(screen.getAllByTestId("where")[0].textContent).toMatch(/campaign$/);
    act(() => events.xAxisLabelClick({}, {}, { labelIndex: 0 }));
    await waitFor(() => expect(screen.getAllByTestId("where")[0].textContent).toMatch(/reasons\?campaign_id=c1&tz=/));
  });

  it("one failing chart doesn't take the page down", async () => {
    bd({ "/breakdown/campaign/mix": () => Promise.reject(new Error("500")) });
    renderAt("/dashboard/call-consumption/campaign");
    expect(await screen.findByText("Failed to load the reasons mix. Please try again.")).toBeInTheDocument();
    expect(await screen.findByText("Worst campaign")).toBeInTheDocument();
    expect(screen.queryByTestId("section-loading")).toBeNull();
  });
});

describe("Hourly Heatmap page", () => {
  const cells = Array.from({ length: 168 }, (_, i) => {
    const d = Math.floor(i / 24), h = i % 24;
    const total = d === 1 && h === 10 ? 12 : 0;
    return { day_of_week: d, day_label: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d], hour: h, hour_label: `${h}`,
      total_calls: total, consumed_calls: total - 6, dropped_calls: total ? 6 : 0, consumption_pct: total ? 50 : 0, drop_pct: total ? 50 : 0 };
  });

  const hourlyHandlers = () => setupHandlers({
    "/hourly/kpis": () => OK({ has_data: true, total_calls: 12, overall_drop_pct: 50, busiest_hour_label: "10:00 AM", busiest_hour_calls: 12,
      date_range_label: "Mar 2 - Mar 8, 2026", risk_window_label: "Mon, Mar 2 10:00 AM", risk_window_drop_pct: 50 }),
    "/hourly/heatmap": () => OK({ from_date: "2026-03-02", to_date: "2026-03-08", cells }),
    "/hourly/trend": () => OK(Array.from({ length: 24 }, (_, h) => ({ hour: h, hour_label: `${h}`, total_calls: h === 10 ? 12 : 0, dropped_calls: h === 10 ? 6 : 0, drop_pct: h === 10 ? 50 : 0 }))),
    "/hourly/summary": () => OK({ has_data: true, rows: Array.from({ length: 24 }, (_, h) => ({ hour: h, name: `H${h}`, ...tally(h === 10 ? 12 : 1, h === 10 ? 6 : 0) })), total: { name: "Total", ...tally(35, 6) } }),
  });

  it("gives Apex a 7 x 24 heatmap (Sunday first so Saturday is on top) and explains the fixed 7-day window", async () => {
    hourlyHandlers();
    renderAt("/dashboard/call-consumption/hourly-heatmap");
    await waitFor(() => expect(lastApexCall("heatmap")).toBeDefined());
    const heat = lastApexCall("heatmap")!;
    const series = heat.series as { name: string; data: { x: string; y: number }[] }[];
    expect(series.map((x) => x.name)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(series.every((x) => x.data.length === 24)).toBe(true);
    expect(series[1].data[10]).toEqual({ x: "10", y: 50 }); // Monday 10:00, drop rate
    expect(heat.height).toBe(320);
    expect(heat.options!.plotOptions.heatmap.colorScale.ranges).toHaveLength(6);
    expect(screen.getByText(/2026-03-02 to 2026-03-08, by weekday and hour/)).toBeInTheDocument();
    expect(screen.getByText("Mon, Mar 2 10:00 AM")).toBeInTheDocument();
    expect(screen.getAllByRole("row").length).toBeGreaterThanOrEqual(26); // header + 24 hours + total
    expect(lastApexCall("line")).toBeDefined(); // the hourly trend
  });

  it("switching the heatmap metric recolours it without asking the server again", async () => {
    hourlyHandlers();
    renderAt("/dashboard/call-consumption/hourly-heatmap");
    await waitFor(() => expect(lastApexCall("heatmap")).toBeDefined());
    const before = calls("/hourly/heatmap").length;
    fireEvent.click(screen.getByRole("radio", { name: "Call volume" }));
    await waitFor(() => {
      const series = lastApexCall("heatmap")!.series as { data: { y: number }[] }[];
      expect(series[1].data[10].y).toBe(12); // volume, not the 50% drop rate
    });
    fireEvent.click(screen.getByRole("radio", { name: "Consumption rate" }));
    await waitFor(() => {
      const series = lastApexCall("heatmap")!.series as { data: { y: number }[] }[];
      expect(series[1].data[10].y).toBe(50);
    });
    expect(calls("/hourly/heatmap")).toHaveLength(before);
  });

  it("with no calls it still draws the full 7 x 24 grid (all palest), and says 'All time' when no range is set", async () => {
    hourlyHandlers();
    handlers["/hourly/heatmap"] = () => OK({ from_date: null, to_date: "2026-10-23", all_time: true,
      cells: cells.map((c) => ({ ...c, total_calls: 0, consumed_calls: 0, dropped_calls: 0, drop_pct: 0, consumption_pct: 0 })) });
    renderAt("/dashboard/call-consumption/hourly-heatmap");
    await waitFor(() => expect(lastApexCall("heatmap")).toBeDefined());
    const series = lastApexCall("heatmap")!.series as { data: { y: number }[] }[];
    expect(series).toHaveLength(7);
    expect(series.every((s) => s.data.length === 24 && s.data.every((p) => p.y === 0))).toBe(true);
    expect(screen.getByText(/^All time, by weekday and hour/)).toBeInTheDocument();
  });
});

describe("Non-Consumption Reasons page", () => {
  const reasons = { campaign_id: "c1", campaign_name: "Spring Push", total_calls: 14, consumed_calls: 8, dropped_calls: 6, drop_pct: 42.9,
    reasons: [{ disposition: "failed", label: "Failed", calls: 4, pct_of_dropped: 66.7 }, { disposition: "no_answer", label: "No answer", calls: 2, pct_of_dropped: 33.3 }],
    raw_reasons: [{ reason: "pipeline-error-openai-llm-failed", disposition: "failed", label: "Failed", calls: 4, pct_of_dropped: 66.7 }] };

  it("reads the campaign and dates from the link and shows shares of DROPPED calls", async () => {
    setupHandlers({ "/reasons": () => OK(reasons) });
    renderAt("/dashboard/call-consumption/reasons?campaign_id=c1&from=2026-03-02&to=2026-03-08&tz=UTC");
    expect(await screen.findByText("Why calls were dropped: Spring Push")).toBeInTheDocument();
    expect(screen.getByText("4 · 66.7%")).toBeInTheDocument();
    expect(screen.getByText("pipeline-error-openai-llm-failed")).toBeInTheDocument();
    expect(calls("/reasons")[0][1]).toMatchObject({ campaign_id: "c1", from: "2026-03-02", to: "2026-03-08", tz: "UTC" });
  });

  it("without a campaign it asks for one instead of calling the API", async () => {
    setupHandlers({ "/reasons": () => OK(reasons) });
    renderAt("/dashboard/call-consumption/reasons");
    expect(await screen.findByText(/Pick a campaign on the Campaign page/)).toBeInTheDocument();
    expect(calls("/reasons")).toHaveLength(0);
  });
});

describe("Weekly & Monthly page (tabs)", () => {
  const prow = (name: string, key: string, total: number, dropped: number, extra: Record<string, unknown> = {}) =>
    ({ key, name, start_date: key, end_date: key, partial: false, calls_change_pct: null, drop_pct_point_change: null, ...tally(total, dropped), ...extra });
  const openMonthly = () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Monthly" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "Monthly" }));
  };
  const report = (granularity: string) => ({
    has_data: true, granularity,
    rows: [prow("Mar 1 - Mar 7, 2026", "2026-03-01", 17, 7), prow("Mar 8 - Mar 14, 2026", "2026-03-08", 2, 0, { calls_change_pct: -88.2, drop_pct_point_change: -41.2, partial: true })],
    total: { name: "Total", ...tally(19, 7) },
  });

  it("loads the weekly report from one endpoint and fills cards, charts and table (newest first)", async () => {
    setupHandlers({ "/period/weekly": () => OK(report("weekly")) });
    renderAt("/dashboard/call-consumption/periodic");
    expect(await screen.findByText("Weekly & Monthly Reports")).toBeInTheDocument();
    await waitFor(() => expect(calls("/period/weekly")).toHaveLength(1));
    // Latest week = the second row (partial, so flagged), with its change vs the week before.
    expect(await screen.findByText("-88.2% vs previous week")).toBeInTheDocument();
    expect(screen.getByText("-41.2 pts vs previous week")).toBeInTheDocument();
    expect(screen.getByText("Partial: still running or cut by the date range")).toBeInTheDocument();
    const body = screen.getAllByRole("row").slice(1).map((r) => r.firstElementChild?.textContent);
    expect(body[0]).toContain("Mar 8 - Mar 14, 2026");   // newest first in the table
    expect(body[1]).toContain("Mar 1 - Mar 7, 2026");
    expect(screen.getByText("Calls vs previous")).toBeInTheDocument();
    // Charts get the timeline oldest -> newest, and the reasons chart keeps that order.
    const combo = lastApexCall("area")!;
    expect((combo.options!.xaxis.categories as string[])).toEqual(["Mar 1 - Mar 7, 2026", "Mar 8 - Mar 14, 2026"]);
    const stacked = apexCalls.filter((c) => c.options?.chart?.stacked).pop()!;
    expect(stacked.options!.xaxis.categories).toEqual(["Mar 1 - Mar 7, 2026"]); // the second week has no drops
  });

  it("the Monthly tab uses the monthly endpoint and wording, and exports the monthly CSV", async () => {
    setupHandlers({ "/period/monthly": () => OK({ ...report("monthly"), rows: [prow("March 2026", "2026-03-01", 17, 7)] }) });
    download.mockResolvedValue({ error: null });
    renderAt("/dashboard/call-consumption/periodic");
    await screen.findByText("Weekly & Monthly Reports");
    openMonthly();
    expect((await screen.findAllByText("No calls in the previous month to compare")).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0][0]).toBe("/period/monthly/export.csv");
    expect(download.mock.calls[0][2]).toBe("MonthlyCallConsumptionReport.csv");
  });

  it("opens on Weekly and only fetches Monthly when its tab is opened, with the same filters", async () => {
    setupHandlers({ "/period/weekly": () => OK(report("weekly")), "/period/monthly": () => OK({ ...report("monthly"), rows: [prow("March 2026", "2026-03-01", 17, 7)] }) });
    renderAt("/dashboard/call-consumption/periodic");
    await screen.findByText("-88.2% vs previous week");
    expect(calls("/period/monthly")).toHaveLength(0);
    openMonthly();
    await waitFor(() => expect(calls("/period/monthly")).toHaveLength(1));
    expect(calls("/period/monthly")[0][1]).toEqual(calls("/period/weekly")[0][1]);
  });

  it("the filters here have no Outcome (it would make every period 0% or 100%), and offer whole weeks / months", async () => {
    setupHandlers({ "/period/weekly": () => OK(report("weekly")), "/period/monthly": () => OK({ ...report("monthly"), rows: [prow("March 2026", "2026-03-01", 17, 7)] }) });
    renderAt("/dashboard/call-consumption/periodic");
    await screen.findByText("-88.2% vs previous week");
    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    expect(screen.queryByRole("combobox", { name: "Outcome" })).toBeNull();
    expect(screen.getByRole("button", { name: "Campaign" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Direction" })).toBeInTheDocument();
    // Weekly presets, then Monthly presets after switching tab.
    fireEvent.click(screen.getByLabelText("Date range"));
    expect(await screen.findByRole("option", { name: "Last 8 weeks" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Last 7 days" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    openMonthly();
    fireEvent.click(screen.getByLabelText("Date range"));
    expect(await screen.findByRole("option", { name: "Last 6 months" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Last 8 weeks" })).toBeNull();
  });

  it("choosing 'Last 8 weeks' sends whole-week dates, and 'include current week' moves the end and re-applies it", async () => {
    setupHandlers({ "/period/weekly": () => OK(report("weekly")) });
    renderAt("/dashboard/call-consumption/periodic");
    await screen.findByText("-88.2% vs previous week");
    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    await choose("Date range", "Last 8 weeks");
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    const w8 = periodPresets("weekly", false).find((p) => p.value === "w8")!;
    await waitFor(() => expect(calls("/period/weekly").at(-1)![1]).toMatchObject({ from: w8.from, to: w8.to }));

    fireEvent.click(screen.getByRole("checkbox", { name: /include the current week/i }));
    const w8c = periodPresets("weekly", true).find((p) => p.value === "w8")!;
    await waitFor(() => expect(calls("/period/weekly").at(-1)![1]).toMatchObject({ from: w8c.from, to: w8c.to }));
    expect(w8c.to > w8.to).toBe(true);
  });

  it("an empty report says so and disables the export", async () => {
    setupHandlers({ "/period/weekly": () => OK({ has_data: false, granularity: "weekly", rows: [], total: { name: "Total", ...tally(1, 0, { total_calls: 0, consumed_calls: 0, dropped_calls: 0, drop_pct: 0, consumption_pct: 0 }) } }) });
    renderAt("/dashboard/call-consumption/periodic");
    await waitFor(() => expect(screen.getAllByText("No Data Found").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("button", { name: /export csv/i })).toBeDisabled();
  });

  it("a failing report shows the error with Retry and stops the spinners", async () => {
    setupHandlers({ "/period/weekly": () => FAIL("Report is down") });
    renderAt("/dashboard/call-consumption/periodic");
    expect((await screen.findAllByText("Report is down")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("section-loading")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Report is down");
  });
});

describe("State page heatmap", () => {
  const NAMES = ["Texas", "California", "New York", "Florida", "Ohio", "Georgia", "Arizona", "Washington", "Colorado", "Oregon",
    "Nevada", "Utah", "Idaho", "Iowa", "Maine", "Kansas", "Alaska", "Hawaii"];
  const KEYS = ["TX", "CA", "NY", "FL", "OH", "GA", "AZ", "WA", "CO", "OR", "NV", "UT", "ID", "IA", "ME", "KS", "AK", "HI"];
  const stateGrid = (n: number) => ({
    states: KEYS.slice(0, n).map((k, i) => ({ key: k, name: NAMES[i], total_calls: 100 - i, drop_pct: 10 })),
    cells: KEYS.slice(0, n).flatMap((k, i) => Array.from({ length: 24 }, (_, h) => ({
      state: k, state_name: NAMES[i], hour: h, hour_label: `${h}`, total_calls: h === 10 ? 10 : 0, consumed_calls: h === 10 ? 9 : 0,
      dropped_calls: h === 10 ? 1 : 0, consumption_pct: h === 10 ? 90 : 0, drop_pct: h === 10 ? 10 : 0 }))),
    unknown_calls: 3,
  });
  const empties = () => {
    const h: Record<string, Handler> = {};
    for (const dim of ["state", "vertical", "campaign"]) {
      h[`/breakdown/${dim}/kpi`] = () => OK({ has_data: true, total_calls: 10, consumed_calls: 9, consumed_pct: 90, dropped_calls: 1, dropped_pct: 10,
        segment_count: 1, worst_segment_name: "x", worst_segment_drop_rate: 10, worst_segment_calls: 10, cost_on_dropped: 0 });
      for (const s of ["combo", "disposition", "mix", "ranking"]) h[`/breakdown/${dim}/${s}`] = () => OK([]);
      h[`/breakdown/${dim}/summary`] = () => OK({ has_data: false, rows: [], total: { name: "Total", ...tally(1, 0) } });
    }
    return h;
  };
  const seriesNames = () => ((lastApexCall("heatmap")!.series as { name: string }[]).map((x) => x.name));

  it("the State page shows a state x hour heatmap, busiest 15 states on top, and says what is left out", async () => {
    setupHandlers({ ...empties(), "/state/heatmap": () => OK(stateGrid(18)) });
    renderAt("/dashboard/call-consumption/state");
    expect(await screen.findByText("Heatmap by state and hour")).toBeInTheDocument();
    await waitFor(() => expect(lastApexCall("heatmap")).toBeDefined());
    expect(seriesNames()).toHaveLength(15);
    expect(seriesNames().at(-1)).toBe("Texas");                 // busiest drawn at the top
    expect((lastApexCall("heatmap")!.series as { data: unknown[] }[])[0].data).toHaveLength(24);
    expect(screen.getByText(/Busiest 15 of 18 states/)).toBeInTheDocument();
    expect(screen.getByText(/3 calls from non-US numbers are not shown/)).toBeInTheDocument();
  });

  it("'Show all' brings in every state and the metric switch recolours without refetching", async () => {
    setupHandlers({ ...empties(), "/state/heatmap": () => OK(stateGrid(18)) });
    renderAt("/dashboard/call-consumption/state");
    fireEvent.click(await screen.findByRole("button", { name: "Show all 18 states" }));
    await waitFor(() => expect(seriesNames()).toHaveLength(18));
    expect(screen.getByRole("button", { name: "Show busiest 15" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Call volume" }));
    await waitFor(() => expect((lastApexCall("heatmap")!.series as { data: { y: number }[] }[])[0].data[10].y).toBe(10));
    expect(calls("/state/heatmap")).toHaveLength(1);
  });

  it("with 15 states or fewer there is no 'Show all' button", async () => {
    setupHandlers({ ...empties(), "/state/heatmap": () => OK(stateGrid(3)) });
    renderAt("/dashboard/call-consumption/state");
    await waitFor(() => expect(lastApexCall("heatmap")).toBeDefined());
    expect(screen.queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(screen.getByText(/3 states, busiest at the top/)).toBeInTheDocument();
  });

  it("the Campaign and Vertical pages neither show nor fetch it", async () => {
    setupHandlers({ ...empties(), "/state/heatmap": () => OK(stateGrid(3)) });
    renderAt("/dashboard/call-consumption/vertical");
    await screen.findByText("Call Consumption by Vertical");
    await waitFor(() => expect(calls("/breakdown/vertical/kpi")).toHaveLength(1));
    expect(screen.queryByText("Heatmap by state and hour")).toBeNull();
    expect(calls("/state/heatmap")).toHaveLength(0);
  });
});

describe("Each page has the filters that suit it", () => {
  const stateSetup = () => {
    const h: Record<string, Handler> = {};
    for (const dim of ["state", "vertical", "campaign"]) {
      h[`/breakdown/${dim}/kpi`] = () => OK({ has_data: false, total_calls: 0, consumed_calls: 0, consumed_pct: 0, dropped_calls: 0, dropped_pct: 0,
        segment_count: 0, worst_segment_name: null, worst_segment_drop_rate: null, worst_segment_calls: null, cost_on_dropped: 0 });
      for (const s of ["combo", "disposition", "mix", "ranking"]) h[`/breakdown/${dim}/${s}`] = () => OK([]);
      h[`/breakdown/${dim}/summary`] = () => OK({ has_data: false, rows: [], total: { name: "Total", ...tally(1, 0) } });
    }
    h["/state/heatmap"] = () => OK({ states: [], cells: [], unknown_calls: 0 });
    h["/hourly/kpis"] = () => OK({ has_data: false, total_calls: 0, overall_drop_pct: 0, busiest_hour_label: "N/A", busiest_hour_calls: 0, date_range_label: "All Time", risk_window_label: "N/A", risk_window_drop_pct: 0 });
    h["/hourly/heatmap"] = () => OK({ from_date: null, to_date: "2026-10-23", all_time: true, cells: [] });
    h["/hourly/trend"] = () => OK([]);
    h["/hourly/summary"] = () => OK({ has_data: false, rows: [], total: { name: "Total", ...tally(1, 0) } });
    setupHandlers(h);
  };
  const openFilter = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /^filter$/i }));
    await screen.findByRole("form", { name: "Filters" });
  };
  const has = (name: string) => !!screen.queryByRole("button", { name }) || !!screen.queryByRole("combobox", { name });

  it("State page: has a State filter, and picking states sends their codes to every widget", async () => {
    stateSetup();
    renderAt("/dashboard/call-consumption/state");
    await openFilter();
    fireEvent.click(await screen.findByRole("button", { name: "State" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Colorado" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "New York" }));
    expect(screen.getByRole("button", { name: "State" })).toHaveTextContent("2 states");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(calls("/state/heatmap").at(-1)![1]).toMatchObject({ states: "CO,NY" }));
    for (const p of ["/breakdown/state/kpi", "/breakdown/state/ranking", "/breakdown/state/summary"]) {
      expect(calls(p).at(-1)![1]).toMatchObject({ states: "CO,NY" });
    }
  });

  it("Overview, Campaign and Vertical have no State filter", async () => {
    stateSetup();
    for (const path of ["campaign", "vertical"]) {
      const { unmount } = renderAt(`/dashboard/call-consumption/${path}`);
      await openFilter();
      expect(has("State")).toBe(false);
      expect(has("Campaign")).toBe(true);
      unmount();
    }
    renderAt("/dashboard/call-consumption/overview");
    await openFilter();
    expect(has("State")).toBe(false);
  });

  it("Vertical page has no Vertical filter; the others do", async () => {
    stateSetup();
    const { unmount } = renderAt("/dashboard/call-consumption/vertical");
    await openFilter();
    expect(has("Vertical")).toBe(false);
    expect(has("Outcome")).toBe(true);
    unmount();
    renderAt("/dashboard/call-consumption/campaign");
    await openFilter();
    expect(has("Vertical")).toBe(true);
  });

  it("Hourly Heatmap page: no Outcome (every cell would be 0% or 100%), but Campaign, Vertical, Agent and Direction", async () => {
    stateSetup();
    renderAt("/dashboard/call-consumption/hourly-heatmap");
    await openFilter();
    expect(has("Outcome")).toBe(false);
    for (const n of ["Campaign", "Vertical", "Agent", "Direction"]) expect(has(n)).toBe(true);
    expect(has("State")).toBe(false);
  });
});

describe("Overview: inbound vs outbound strip", () => {
  it("shows both directions side by side, with a link to the full report", async () => {
    renderAt("/dashboard/call-consumption/overview");
    const out = await screen.findByTestId("direction-outbound");
    const inn = screen.getByTestId("direction-inbound");
    expect(within(out).getByText("16")).toBeInTheDocument();
    expect(within(out).getByText("56.3%")).toBeInTheDocument();      // consumption
    expect(within(out).getByTestId("drop-rate")).toHaveTextContent("43.80%");
    expect(within(inn).getByText("7")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /full report/i })).toHaveAttribute("href", "/dashboard/call-consumption/direction");
    expect(calls("/overview/directions")).toHaveLength(1);
  });

  it("a direction with no calls says so instead of showing 0%", async () => {
    setupHandlers({ "/overview/directions": () => OK({ outbound: dsum(16, 7), inbound: dsum(0, 0) }) });
    renderAt("/dashboard/call-consumption/overview");
    const inn = await screen.findByTestId("direction-inbound");
    expect(within(inn).getByText("No calls")).toBeInTheDocument();
    expect(within(inn).queryByTestId("drop-rate")).toBeNull();
  });

  it("its failure stays inside its own card", async () => {
    setupHandlers({ "/overview/directions": () => FAIL("Strip is down") });
    renderAt("/dashboard/call-consumption/overview");
    expect(await screen.findByText("Strip is down")).toBeInTheDocument();
    expect(screen.getByText("March 2026")).toBeInTheDocument();
  });
});

describe("Inbound & Outbound page", () => {
  const seg = (name: string, key: string, total: number, dropped: number, extra: Record<string, unknown> = {}) =>
    ({ key, name, calls_change_pct: null, drop_pct_point_change: null, ...tally(total, dropped), ...extra });
  const rep = (direction: string, label: string, rows: ReturnType<typeof seg>[], kpiExtra: Record<string, unknown> = {}) => ({
    direction, has_data: rows.length > 0, segment_label: label,
    kpis: { has_data: rows.length > 0, has_previous: true, total_calls: 16, total_calls_change_pct: -10, consumption_pct: 56.3, consumption_pct_point_change: 2,
            drop_pct: 43.8, drop_pct_point_change: -3.5, ...kpiExtra },
    rows, total: { name: "Total", ...tally(16, 7) },
  });
  const outbound = rep("outbound", "Campaign", [seg("Spring Push", "c1", 14, 6, { calls_change_pct: -78.6, drop_pct_point_change: 5.2 }), seg("No campaign", "", 2, 1)]);
  const inbound = rep("inbound", "Number", [seg("Main line", "n1", 4, 1), seg("Unknown number", "", 1, 0)]);
  const openInbound = () => {
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Inbound" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "Inbound" }));
  };

  it("opens on Outbound with one row per campaign, change columns and cards", async () => {
    setupHandlers({ "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    renderAt("/dashboard/call-consumption/direction");
    expect(await screen.findByText("Inbound & Outbound")).toBeInTheDocument();
    expect(await screen.findByText("By campaign")).toBeInTheDocument();
    expect(screen.getAllByText("Spring Push").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Campaign" })).toBeInTheDocument();
    expect(screen.getByText("Calls vs previous")).toBeInTheDocument();
    expect(screen.getByText("-78.6%").className).toContain("text-destructive");    // fewer calls: bad
    expect(screen.getByText("+5.2 pts").className).toContain("text-destructive");  // drop rate up: bad
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);                   // a row with nothing to compare
    expect(screen.getByText("-3.5 pts vs previous period").className).toContain("text-success");
    expect(screen.getByText("Busiest campaign")).toBeInTheDocument();
    expect(calls("/direction/inbound")).toHaveLength(0);                          // not fetched until its tab opens
  });

  it("the Inbound tab is by phone number and fetches only when opened", async () => {
    setupHandlers({ "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    renderAt("/dashboard/call-consumption/direction");
    await screen.findByText("By campaign");
    openInbound();
    expect(await screen.findByText("By number")).toBeInTheDocument();
    expect(screen.getAllByText("Main line").length).toBeGreaterThan(0);
    expect(screen.getByRole("columnheader", { name: "Number" })).toBeInTheDocument();
    expect(screen.getByText("Busiest number")).toBeInTheDocument();
    expect(calls("/direction/inbound")).toHaveLength(1);
  });

  it("clicking an outbound campaign opens its reasons; 'No campaign' and inbound numbers do not", async () => {
    setupHandlers({ "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    renderAt("/dashboard/call-consumption/direction");
    const table = (await screen.findByText("By campaign")).closest("section")!;
    fireEvent.click(within(table).getByText("No campaign"));
    expect(screen.getAllByTestId("where")[0].textContent).toMatch(/direction$/);
    fireEvent.click(within(table).getByText("Spring Push"));
    await waitFor(() => expect(screen.getAllByTestId("where")[0].textContent).toMatch(/reasons\?campaign_id=c1/));
  });

  it("inbound rows are not links", async () => {
    setupHandlers({ "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    renderAt("/dashboard/call-consumption/direction");
    await screen.findByText("By campaign");
    openInbound();
    const table = (await screen.findByText("By number")).closest("section")!;
    fireEvent.click(within(table).getByText("Main line"));
    expect(screen.getAllByTestId("where")[0].textContent).toMatch(/direction$/);
  });

  it("each tab shows only the filters that fit: Campaign on Outbound, Number on Inbound, never Direction", async () => {
    setupHandlers({ "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    renderAt("/dashboard/call-consumption/direction");
    await screen.findByText("By campaign");
    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    const has = (n: string) => !!screen.queryByRole("button", { name: n }) || !!screen.queryByRole("combobox", { name: n });
    expect([has("Campaign"), has("Number"), has("Direction")]).toEqual([true, false, false]);
    openInbound();
    await screen.findByText("By number");
    expect([has("Campaign"), has("Number"), has("Direction")]).toEqual([false, true, false]);
    for (const n of ["Vertical", "Agent", "Outcome"]) expect(has(n)).toBe(true);
  });

  it("a number picked on Inbound is sent as `numbers`, and dropped again when you go back to Outbound", async () => {
    const inboundOptions = { ...options, numbers: [{ id: "n1", name: "Main line" }] };
    setupHandlers({ "/filters": () => OK(inboundOptions), "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    renderAt("/dashboard/call-consumption/direction");
    await screen.findByText("By campaign");
    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    openInbound();
    fireEvent.click(await screen.findByRole("button", { name: "Number" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Main line" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    await waitFor(() => expect(calls("/direction/inbound").at(-1)![1]).toMatchObject({ numbers: "n1" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Outbound" }), { button: 0 });
    fireEvent.click(screen.getByRole("tab", { name: "Outbound" }));
    await waitFor(() => expect(calls("/direction/outbound").length).toBeGreaterThan(1));
    expect(calls("/direction/outbound").at(-1)![1].numbers).toBeUndefined();
  });

  it("exports the right CSV for each tab", async () => {
    setupHandlers({ "/direction/outbound": () => OK(outbound), "/direction/inbound": () => OK(inbound) });
    download.mockResolvedValue({ error: null });
    renderAt("/dashboard/call-consumption/direction");
    await screen.findByText("By campaign");
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0][0]).toBe("/direction/outbound/export.csv");
    expect(download.mock.calls[0][2]).toBe("OutboundCallConsumptionByCampaign.csv");
    openInbound();
    await screen.findByText("By number");
    fireEvent.click(screen.getByRole("button", { name: /export csv/i }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
    expect(download.mock.calls[1][0]).toBe("/direction/inbound/export.csv");
  });

  it("no calls says so and disables the export; a failure shows Retry", async () => {
    setupHandlers({ "/direction/outbound": () => OK(rep("outbound", "Campaign", [])) });
    renderAt("/dashboard/call-consumption/direction");
    expect(await screen.findByText("No outbound calls for these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export csv/i })).toBeDisabled();
  });

  it("a failing report shows the error and stops the spinners", async () => {
    setupHandlers({ "/direction/outbound": () => FAIL("Report is down") });
    renderAt("/dashboard/call-consumption/direction");
    expect((await screen.findAllByText("Report is down")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("section-loading")).toBeNull();
    expect(toast.error).toHaveBeenCalledWith("Report is down");
  });
});
