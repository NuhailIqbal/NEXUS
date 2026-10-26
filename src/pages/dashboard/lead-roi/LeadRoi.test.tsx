import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/services/api", () => ({
  api: { getCallConsumption: vi.fn(), downloadCallConsumption: vi.fn(), getMyRole: vi.fn(), getLeadValues: vi.fn(), saveLeadValues: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import type { CampaignReport, LeadRoiKpis, LeadValues, NumberReport, PeriodReport } from "@/lib/leadRoi";
import LeadRoi from "./LeadRoi";

const get = api.getCallConsumption as ReturnType<typeof vi.fn>;
const download = api.downloadCallConsumption as ReturnType<typeof vi.fn>;
const getRole = api.getMyRole as ReturnType<typeof vi.fn>;
const getValues = api.getLeadValues as ReturnType<typeof vi.fn>;
const saveValues = api.saveLeadValues as ReturnType<typeof vi.fn>;

const OK = (data: unknown) => Promise.resolve({ data, error: null });
const FAIL = (error = "boom") => Promise.resolve({ data: null, error });

const row = (over = {}) => ({
  calls: 17, spend: 10, leads: 6, qualified_leads: 4, cost_per_lead: 1.67, cost_per_qualified_lead: 2.5,
  revenue: null, profit: null, roi_pct: null, ...over,
});
const kpis = (over: Partial<LeadRoiKpis> = {}): LeadRoiKpis => ({
  has_data: true, has_previous: true, has_value: false, unvalued_campaigns: 0, ...row(),
  spend_change_pct: 150, leads_change_pct: 200, qualified_leads_change_pct: 100,
  cost_per_lead_change_pct: -16.7, cost_per_qualified_lead_change_pct: 10, roi_point_change: null, ...over,
});
const valued = { has_value: true, revenue: 440, profit: 430, roi_pct: 4300, roi_point_change: 12.3 };

const campaignReport = (over: Partial<CampaignReport> = {}): CampaignReport => ({
  has_data: true, has_value: false,
  rows: [
    { key: "c1", name: "Spring Push", ...row({ calls: 12, spend: 7, leads: 5, qualified_leads: 3, cost_per_lead: 1.4, cost_per_qualified_lead: 2.33 }),
      value_per_qualified_lead: null, value_per_lead: null, value_source: null },
    { key: "c2", name: "Listings", ...row({ calls: 4, spend: 1, leads: 0, qualified_leads: 0, cost_per_lead: null, cost_per_qualified_lead: null }),
      value_per_qualified_lead: null, value_per_lead: null, value_source: null },
  ],
  total: { name: "Total", ...row() },
  ...over,
});
const periodReport = (granularity: "weekly" | "monthly" = "weekly", over: Partial<PeriodReport> = {}): PeriodReport => ({
  has_data: true, has_value: false, granularity,
  rows: [
    { key: "2026-03-01", name: "Mar 1 - Mar 7, 2026", start_date: "2026-03-01", end_date: "2026-03-07", partial: false, ...row() },
    { key: "2026-03-08", name: "Mar 8 - Mar 14, 2026", start_date: "2026-03-08", end_date: "2026-03-14", partial: true,
      ...row({ spend: 2, calls: 2, leads: 1, qualified_leads: 1, cost_per_lead: 2, cost_per_qualified_lead: 2 }) },
  ],
  total: { name: "Total", ...row({ spend: 12 }) },
  ...over,
});
const numberReport = (over: Partial<NumberReport> = {}): NumberReport => ({
  has_data: true, has_value: false,
  rows: [
    { key: "n1", name: "Main line", ...row({ calls: 3, spend: 3, leads: 2, qualified_leads: 1, cost_per_lead: 1.5, cost_per_qualified_lead: 3 }) },
    { key: "n2", name: "+15551230002", ...row({ calls: 2, spend: 1, leads: 0, qualified_leads: 0, cost_per_lead: null, cost_per_qualified_lead: null }) },
  ],
  total: { name: "Total", ...row({ calls: 5, spend: 4, leads: 2, qualified_leads: 1, cost_per_lead: 2, cost_per_qualified_lead: 4 }) },
  ...over,
});
const values: LeadValues = {
  account: { value_per_qualified_lead: null, value_per_lead: null },
  campaigns: [
    { campaign_id: "c1", name: "Spring Push", value_per_qualified_lead: null, value_per_lead: null },
    { campaign_id: "c2", name: "Listings", value_per_qualified_lead: 5, value_per_lead: null },
  ],
};

type Handler = (params: Record<string, string | undefined>) => Promise<unknown>;
let handlers: Record<string, Handler>;

function setup(over: Record<string, Handler> = {}) {
  handlers = {
    "/filters": () => OK({ campaigns: [{ id: "c1", name: "Spring Push" }], agents: [], verticals: [], states: [], numbers: [], dispositions: [] }),
    "/lead-roi/kpis": () => OK(kpis()),
    "/lead-roi/campaign": () => OK(campaignReport()),
    "/lead-roi/number": () => OK(numberReport()),
    "/lead-roi/period/weekly": () => OK(periodReport("weekly")),
    "/lead-roi/period/monthly": () => OK(periodReport("monthly")),
    ...over,
  };
  get.mockImplementation((path: string, params: Record<string, string | undefined> = {}) =>
    handlers[path] ? handlers[path](params) : FAIL(`unmocked ${path}`));
}

const calls = (path: string) => get.mock.calls.filter((c) => c[0] === path);
const renderPage = () => render(<MemoryRouter><LeadRoi /></MemoryRouter>);
/** Open a tab (Radix tabs activate on mouse down). */
const openTab = (name: string) => {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 });
  fireEvent.click(screen.getByRole("tab", { name }));
};

beforeEach(() => {
  vi.clearAllMocks();
  setup();
  getRole.mockResolvedValue({ data: { is_owner: true }, error: null });
  getValues.mockImplementation(() => OK(values));
  saveValues.mockImplementation(() => OK(values));
  download.mockResolvedValue({ error: null });
});

/** The KPI card with this label. */
const card = (label: string) =>
  screen.getAllByText(label).find((el) => el.className.includes("uppercase"))!.parentElement as HTMLElement;

describe("headline numbers", () => {
  it("shows spend, leads and the two costs", async () => {
    renderPage();
    expect(await screen.findByText("Total spend")).toBeInTheDocument();
    await waitFor(() => expect(within(card("Total spend")).getByText("$10.00")).toBeInTheDocument());
    expect(within(card("Total spend")).getByText("17 calls")).toBeInTheDocument();
    expect(within(card("Leads")).getByText("6")).toBeInTheDocument();
    expect(within(card("Leads")).getByText("4 qualified")).toBeInTheDocument();
    expect(within(card("Cost per lead")).getByText("$1.67")).toBeInTheDocument();
    expect(within(card("Cost per qualified lead")).getByText("$2.50")).toBeInTheDocument();
  });

  it("colours a falling cost as good news and a rising one as bad", async () => {
    renderPage();
    const fall = await screen.findByText("-16.7% vs previous period");
    expect(fall.className).toContain("text-success");
    expect(screen.getByText("+10.0% vs previous period").className).toContain("text-destructive");
    expect(screen.getByText("+200.0% vs previous period").className).toContain("text-success"); // more leads
  });

  it("shows no change when the previous period had no calls", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ has_previous: false })) });
    renderPage();
    await screen.findByText("Total spend");
    await waitFor(() => expect(screen.queryByTestId("kpi-loading")).toBeNull());
    expect(screen.queryByText(/vs previous period/)).toBeNull();
  });

  it("shows a dash and a note, not $0.00, when there are no leads", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ leads: 0, qualified_leads: 0, cost_per_lead: null, cost_per_qualified_lead: null })) });
    renderPage();
    await waitFor(() => expect(within(card("Cost per lead")).getByText("—")).toBeInTheDocument());
    expect(within(card("Cost per lead")).getByText("No leads in this period")).toBeInTheDocument();
    expect(within(card("Cost per qualified lead")).getByText("—")).toBeInTheDocument();
    expect(within(card("Cost per qualified lead")).getByText("No qualified leads in this period")).toBeInTheDocument();
  });

  it("says No Data Found when there are no calls at all, and offers no value prompt", async () => {
    setup({
      "/lead-roi/kpis": () => OK(kpis({ has_data: false, has_previous: false, calls: 0, spend: 0, leads: 0, qualified_leads: 0, cost_per_lead: null, cost_per_qualified_lead: null })),
      "/lead-roi/campaign": () => OK(campaignReport({ has_data: false, rows: [] })),
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText("No Data Found").length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByTestId("value-prompt")).toBeNull();
  });

  it("toasts and shows dashes when the headline numbers fail, while the other widgets still load", async () => {
    setup({ "/lead-roi/kpis": () => FAIL("kpi boom") });
    renderPage();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("kpi boom"));
    expect(await screen.findByText("Spring Push")).toBeInTheDocument();
    expect(within(card("Total spend")).getByText("—")).toBeInTheDocument();
  });

  it("shows an inline error with Retry when the campaign report fails", async () => {
    let n = 0;
    setup({ "/lead-roi/campaign": () => (n++ === 0 ? FAIL("campaign boom") : OK(campaignReport())) });
    renderPage();
    expect(await screen.findByText("campaign boom")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    expect(await screen.findByText("Spring Push")).toBeInTheDocument();
  });
});

describe("ROI", () => {
  it("shows costs only, with no Revenue or ROI cards and no ROI column, when no value is set", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    await waitFor(() => expect(within(card("Total spend")).getByText("$10.00")).toBeInTheDocument());
    expect(screen.queryByText("Revenue")).toBeNull();
    expect(screen.queryByText("ROI")).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "ROI" })).toBeNull();
    expect(screen.queryByText(/Set what a lead is worth/)).toBeNull();
    expect(screen.getByRole("button", { name: /lead values/i })).toBeInTheDocument();   // the way to turn them on
  });

  it("shows the four cost cards in a four-column row, and six cards in three columns once a value is set", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    expect(card("Total spend").parentElement!.className).toContain("lg:grid-cols-4");
  });

  it("shows revenue, profit and ROI once a value is set", async () => {
    setup({
      "/lead-roi/kpis": () => OK(kpis(valued)),
      "/lead-roi/campaign": () => OK(campaignReport({ has_value: true, total: { name: "Total", ...row({ revenue: 440, profit: 430, roi_pct: 4300 }) } })),
    });
    renderPage();
    await waitFor(() => expect(within(card("Revenue")).getByText("$440.00")).toBeInTheDocument());
    expect(within(card("ROI")).getByText("4,300%")).toBeInTheDocument();
    expect(within(card("ROI")).getByText("Profit $430.00")).toBeInTheDocument();
    expect(within(card("ROI")).getByText("+12.3 pts vs previous period").className).toContain("text-success");
    expect(card("Total spend").parentElement!.className).toContain("lg:grid-cols-3");
    expect(await screen.findByRole("columnheader", { name: "ROI" })).toBeInTheDocument();
    expect(within(screen.getAllByTestId("total-row")[0]).getByText("4,300%")).toBeInTheDocument();
  });

  it("shows a loss in red", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ ...valued, revenue: 4, profit: -6, roi_pct: -60 })) });
    renderPage();
    const roi = await screen.findByText("-60%");
    expect(roi.className).toContain("text-destructive");
  });

  it("shows a dash for ROI when nothing was spent", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ ...valued, spend: 0, roi_pct: null, cost_per_lead: null })) });
    renderPage();
    await waitFor(() => expect(within(card("ROI")).getByText("Nothing spent in this period")).toBeInTheDocument());
  });

  it("warns when campaigns with leads have no value", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ ...valued, unvalued_campaigns: 2 })) });
    renderPage();
    expect(await screen.findByTestId("unvalued-warning")).toHaveTextContent("2 campaigns have leads but no value set");
  });
});

describe("tables", () => {
  it("lists every campaign with its costs, dashes where there are no leads, and the Total", async () => {
    renderPage();
    const spring = (await screen.findByText("Spring Push")).closest("tr") as HTMLElement;
    expect(within(spring).getByText("$1.40")).toBeInTheDocument();
    expect(within(spring).getByText("$2.33")).toBeInTheDocument();
    const listings = screen.getByText("Listings").closest("tr") as HTMLElement;
    expect(within(listings).getAllByText("—")).toHaveLength(2);
    expect(within(screen.getAllByTestId("total-row")[0]).getByText("$10.00")).toBeInTheDocument();
  });

});

describe("Weekly / Monthly summary", () => {
  it("lists the weeks newest first, marks a partial one and totals them", async () => {
    renderPage();
    const newest = (await screen.findByText("Mar 8 - Mar 14, 2026")).closest("tr") as HTMLElement;
    expect(within(newest).getByText("partial")).toBeInTheDocument();
    expect(within(newest).getAllByText("$2.00")).toHaveLength(3);               // spend and the two costs
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows.findIndex((t) => t.includes("Mar 8"))).toBeLessThan(rows.findIndex((t) => t.includes("Mar 1 -")));
    expect(screen.getByText("Week")).toBeInTheDocument();
  });

  it("loads the monthly summary only when the Monthly tab is opened", async () => {
    renderPage();
    await screen.findByText("Mar 8 - Mar 14, 2026");
    expect(calls("/lead-roi/period/monthly")).toHaveLength(0);
    openTab("Monthly");
    await waitFor(() => expect(calls("/lead-roi/period/monthly")).toHaveLength(1));
    expect(await screen.findByText("Month")).toBeInTheDocument();
  });

  it("follows the Outbound / Inbound tab", async () => {
    renderPage();
    await screen.findByText("Mar 8 - Mar 14, 2026");
    openTab("Inbound");
    await waitFor(() => expect(calls("/lead-roi/period/weekly").map((c) => c[1]?.direction)).toEqual(["outbound", "inbound"]));
  });

  it("exports the weekly CSV from the server", async () => {
    renderPage();
    await screen.findByText("Mar 8 - Mar 14, 2026");
    const buttons = screen.getAllByRole("button", { name: /export csv/i });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(download).toHaveBeenCalledWith("/lead-roi/period/weekly/export.csv", expect.objectContaining({ direction: "outbound" }), "WeeklyCostPerLead.csv"));
  });

  it("disables the export when there are no calls", async () => {
    setup({ "/lead-roi/period/weekly": () => OK(periodReport("weekly", { has_data: false, rows: [] })) });
    renderPage();
    await screen.findByText("Spring Push");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /export csv/i }).pop()).toBeDisabled());
  });

  it("shows revenue, profit and ROI columns once a value is set", async () => {
    setup({ "/lead-roi/period/weekly": () => OK(periodReport("weekly", { has_value: true })) });
    renderPage();
    await screen.findByText("Mar 8 - Mar 14, 2026");
    expect(screen.getAllByRole("columnheader", { name: "ROI" }).length).toBeGreaterThan(0);
  });
});

describe("Outbound / Inbound tab", () => {
  const dirOf = (path: string) => get.mock.calls.filter((c) => c[0] === path).map((c) => c[1]?.direction);

  it("opens on Outbound and scopes the cards and the breakdown to outbound calls", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    expect(screen.getByRole("tab", { name: "Outbound" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Outbound calls by campaign")).toBeInTheDocument();
    expect(dirOf("/lead-roi/kpis")).toEqual(["outbound"]);
    expect(dirOf("/lead-roi/campaign")).toEqual(["outbound"]);
    expect(calls("/lead-roi/number")).toHaveLength(0);
  });

  it("switches the whole page to inbound: cards and the phone-number report", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    openTab("Inbound");
    await screen.findByText("Main line");
    expect(screen.getByText("Inbound calls by phone number")).toBeInTheDocument();
    expect(screen.queryByText(/Cost per lead by/)).toBeNull();                 // no charts on this page
    expect(screen.queryByText("Spring Push")).toBeNull();
    expect(dirOf("/lead-roi/kpis")).toEqual(["outbound", "inbound"]);
    expect(dirOf("/lead-roi/number")).toEqual(["inbound"]);
  });

  it("goes back to the outbound campaigns when Outbound is opened again", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    openTab("Inbound");
    await screen.findByText("Main line");
    openTab("Outbound");
    expect(await screen.findByText("Spring Push")).toBeInTheDocument();
    expect(screen.queryByText("Main line")).toBeNull();
  });

  it("offers no Direction filter, and no campaign filter on the inbound tab", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    expect(screen.queryByLabelText("Direction")).toBeNull();
    expect(screen.getByLabelText("Campaign")).toBeInTheDocument();
    openTab("Inbound");
    await screen.findByText("Main line");
    expect(screen.queryByLabelText("Campaign")).toBeNull();
    expect(screen.getByLabelText("Number")).toBeInTheDocument();
  });

  it("lists inbound numbers with their costs, a dash where a number made no leads, and the Total", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    openTab("Inbound");
    const main = (await screen.findByText("Main line")).closest("tr") as HTMLElement;
    expect(within(main).getByText("$1.50")).toBeInTheDocument();
    expect(within(main).getAllByText("$3.00")).toHaveLength(2);                 // spend and cost per qualified lead
    const quiet = screen.getByText("+15551230002").closest("tr") as HTMLElement;
    expect(within(quiet).getAllByText("—")).toHaveLength(2);
    expect(screen.getByText("Phone number")).toBeInTheDocument();
  });

  it("exports the number CSV", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    openTab("Inbound");
    await screen.findByText("Main line");
    fireEvent.click(screen.getAllByRole("button", { name: /export csv/i })[0]);
    await waitFor(() => expect(download).toHaveBeenCalledWith("/lead-roi/number/export.csv", expect.objectContaining({ direction: "inbound" }), "InboundCostPerLeadByNumber.csv"));
  });

  it("says so when there are no inbound calls and disables that export", async () => {
    setup({ "/lead-roi/number": () => OK(numberReport({ has_data: false, rows: [] })) });
    renderPage();
    await screen.findByText("Spring Push");
    openTab("Inbound");
    expect(await screen.findAllByText("No inbound calls in this period")).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /export csv/i })[0]).toBeDisabled());
  });

  it("words the no-value warning for inbound leads, which have no campaign", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ ...valued, unvalued_campaigns: 1 })) });
    renderPage();
    expect(await screen.findByTestId("unvalued-warning")).toHaveTextContent("1 campaign has leads but no value set");
    openTab("Inbound");
    await waitFor(() => expect(screen.getByTestId("unvalued-warning")).toHaveTextContent("Inbound leads have no value set, so they count as $0 revenue."));
  });

  it("refetches the cards and the open tab after the lead values are saved", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /lead values/i }));
    fireEvent.change(await screen.findByLabelText("Qualified lead (handed to a person)"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("/lead-roi/campaign")).toHaveLength(2));
    await waitFor(() => expect(calls("/lead-roi/kpis")).toHaveLength(2));
  });
});

describe("filters and export", () => {
  it("sends the standard filters, and no vertical / agent / outcome controls are offered", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    expect(get).toHaveBeenCalledWith("/lead-roi/kpis", expect.objectContaining({ tz: expect.any(String) }));
    fireEvent.click(screen.getByRole("button", { name: /^filter$/i }));
    expect(screen.queryByLabelText("Vertical")).toBeNull();
    expect(screen.queryByLabelText("Agent")).toBeNull();
    expect(screen.queryByLabelText("Outcome")).toBeNull();
    expect(screen.queryByLabelText("Direction")).toBeNull();
  });

  it("exports the campaign table from the server's own CSV", async () => {
    renderPage();
    await screen.findByText("Spring Push");
    fireEvent.click(screen.getAllByRole("button", { name: /export csv/i })[0]);
    await waitFor(() => expect(download).toHaveBeenCalledWith("/lead-roi/campaign/export.csv", expect.objectContaining({ direction: "outbound" }), "OutboundCostPerLeadByCampaign.csv"));
  });

  it("disables the export when there is nothing to export", async () => {
    setup({ "/lead-roi/campaign": () => OK(campaignReport({ has_data: false, rows: [] })) });
    renderPage();
    await waitFor(() => expect(screen.getAllByRole("button", { name: /export csv/i })[0]).toBeDisabled());
  });
});

describe("lead values dialog", () => {
  const open = async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /lead values/i }));
    return screen.findByLabelText("Qualified lead (handed to a person)");
  };

  it("loads the saved values, including each campaign's own", async () => {
    await open();
    expect(getValues).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Qualified lead (handed to a person)")).toHaveValue("");
    expect(screen.getAllByDisplayValue("5")).toHaveLength(1);                                // Listings' own value
    expect(screen.getByText("Per campaign")).toBeInTheDocument();
  });

  it("saves only what changed and refetches the numbers", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "$125.50" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveValues).toHaveBeenCalledTimes(1));
    expect(saveValues).toHaveBeenCalledWith({ campaign_id: null, value_per_qualified_lead: 125.5, value_per_lead: null });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Lead values saved"));
    await waitFor(() => expect(calls("/lead-roi/kpis")).toHaveLength(2));
    expect(calls("/lead-roi/campaign")).toHaveLength(2);
  });

  it("saves a campaign's own value with its id", async () => {
    await open();
    fireEvent.change(document.getElementById("lv-c1-q")!, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveValues).toHaveBeenCalledWith({ campaign_id: "c1", value_per_qualified_lead: 10, value_per_lead: null }));
  });

  it("clears a value when its box is emptied", async () => {
    await open();
    fireEvent.change(document.getElementById("lv-c2-q")!, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveValues).toHaveBeenCalledWith({ campaign_id: "c2", value_per_qualified_lead: null, value_per_lead: null }));
  });

  it("refuses a typo without saving anything", async () => {
    const input = await open();
    fireEvent.change(input, { target: { value: "fifty" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("All campaigns: the value of a qualified lead must be a number");
    expect(saveValues).not.toHaveBeenCalled();
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    saveValues.mockImplementation(() => FAIL("Only account owners can perform this action"));
    const input = await open();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Only account owners can perform this action")).toBeInTheDocument();
    expect(screen.getByLabelText("Qualified lead (handed to a person)")).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("is read-only for a team member", async () => {
    getRole.mockResolvedValue({ data: { is_owner: false }, error: null });
    const input = await open();
    await waitFor(() => expect(input).toBeDisabled());
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("Only the account owner can change these values.")).toBeInTheDocument();
  });

  it("shows an error when the values cannot be loaded", async () => {
    getValues.mockImplementation(() => FAIL("values boom"));
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /lead values/i }));
    expect(await screen.findByText("values boom")).toBeInTheDocument();
  });

  it("opens from the Lead values button in the page header", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /lead values/i }));
    expect(await screen.findByText("What is a lead worth?")).toBeInTheDocument();
  });

  it("opens from the no-value warning too", async () => {
    setup({ "/lead-roi/kpis": () => OK(kpis({ ...valued, unvalued_campaigns: 1 })) });
    renderPage();
    fireEvent.click(await within(await screen.findByTestId("unvalued-warning")).findByRole("button", { name: "Set a value" }));
    expect(await screen.findByText("What is a lead worth?")).toBeInTheDocument();
  });
});
