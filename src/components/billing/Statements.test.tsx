import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getBillingStatements: vi.fn(), downloadBillingStatement: vi.fn(), getBillingInvoices: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Statements from "./Statements";

const month = (over = {}) => ({
  month: "2026-09", label: "September 2026", in_progress: false, opening_balance: 104.6, credits: 59, charges: 12,
  topups: 50, call_charges: 10, closing_balance: 151.6, ...over,
});
const invoice = (over = {}) => ({
  id: "in_1", amount: 5000, currency: "usd", status: "paid", created: 1_790_000_000,
  invoice_url: "https://invoice.stripe.test/i/1", pdf: "https://invoice.stripe.test/i/1/pdf", ...over,
});
const statements = api.getBillingStatements as ReturnType<typeof vi.fn>;
const invoices = api.getBillingInvoices as ReturnType<typeof vi.fn>;
const download = api.downloadBillingStatement as ReturnType<typeof vi.fn>;

function mock(months: object[], inv: object[] = [], invError: string | null = null) {
  statements.mockResolvedValue({ data: months, error: null });
  invoices.mockResolvedValue({ data: inv, error: invError });
}

beforeEach(() => vi.clearAllMocks());

describe("Statements", () => {
  it("lists a row per month with its balances and a download button each", async () => {
    mock([month({ month: "2026-10", label: "October 2026", in_progress: true, opening_balance: 151.6, closing_balance: 140 }), month()]);
    render(<Statements />);
    await screen.findByText("October 2026");
    expect(screen.getByText("September 2026")).toBeInTheDocument();
    expect(screen.getByText("Month to date")).toBeInTheDocument();
    expect(screen.getAllByText("$151.60")).toHaveLength(2);   // September closing, October opening
    expect(screen.getByText("$104.60")).toBeInTheDocument();
    expect(screen.getByText("$140.00")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Download .* statement/ })).toHaveLength(2);
  });

  it("downloads the statement of the month clicked", async () => {
    mock([month()]);
    download.mockResolvedValue({ error: null });
    render(<Statements />);
    fireEvent.click(await screen.findByRole("button", { name: "Download September 2026 statement" }));
    await waitFor(() => expect(download).toHaveBeenCalledWith("2026-09"));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the error when a download fails", async () => {
    mock([month()]);
    download.mockResolvedValue({ error: "There is no statement for that month." });
    render(<Statements />);
    fireEvent.click(await screen.findByRole("button", { name: "Download September 2026 statement" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("There is no statement for that month."));
  });

  it("explains an empty account", async () => {
    mock([]);
    render(<Statements />);
    await screen.findByText(/No statements yet/);
    expect(screen.getByText("No card invoices yet.")).toBeInTheDocument();
  });

  it("links Stripe invoices to the hosted page and PDF in a new tab", async () => {
    mock([month()], [invoice()]);
    render(<Statements />);
    await screen.findByText("$50.00");
    const view = screen.getByRole("link", { name: /View/ });
    expect(view).toHaveAttribute("href", "https://invoice.stripe.test/i/1");
    expect(view).toHaveAttribute("target", "_blank");
    expect(view.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: /PDF/ })).toHaveAttribute("href", "https://invoice.stripe.test/i/1/pdf");
    expect(screen.getByText("paid")).toBeInTheDocument();
  });

  it("a failing invoice lookup does not hide the statements", async () => {
    mock([month()], [], "stripe down");
    render(<Statements />);
    await screen.findByText("September 2026");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be loaded/);
    expect(screen.queryByText(/stripe down/)).not.toBeInTheDocument();
  });

  it("says statements are not tax invoices and never names the voice provider", async () => {
    mock([month()]);
    const { container } = render(<Statements />);
    await screen.findByText("September 2026");
    expect(container.textContent).toMatch(/not tax invoices/);
    expect(container.textContent).not.toMatch(/vapi/i);
  });
});
