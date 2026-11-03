import "@/test/radix-stubs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/services/api", () => ({
  api: { getWalletTransactions: vi.fn(), downloadBillingReceipt: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { api } from "@/services/api";
import Transactions from "./Transactions";

const txn = (over = {}) => ({
  id: "11111111-2222-3333-4444-555555555555", kind: "topup", amount: 50, balance_after: 70,
  description: "Added $50.00 to balance", created_at: "2026-09-02T10:00:00Z", ...over,
});
const list = api.getWalletTransactions as ReturnType<typeof vi.fn>;
const receipt = api.downloadBillingReceipt as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe("Transactions receipts", () => {
  it("offers a receipt for top-ups only", async () => {
    list.mockResolvedValue({
      data: [txn(), txn({ id: "p", kind: "promo", amount: 20, description: "Welcome credit" }),
             txn({ id: "ph", kind: "phone", amount: -3, description: "Phone number" })], error: null,
    });
    render(<Transactions />);
    await screen.findByText("Added $50.00 to balance");
    expect(screen.getAllByRole("button", { name: /Download receipt/ })).toHaveLength(1);
  });

  it("downloads the receipt of the clicked top-up", async () => {
    list.mockResolvedValue({ data: [txn()], error: null });
    receipt.mockResolvedValue({ error: null });
    render(<Transactions />);
    fireEvent.click(await screen.findByRole("button", { name: /Download receipt/ }));
    await waitFor(() => expect(receipt).toHaveBeenCalledWith("11111111-2222-3333-4444-555555555555"));
  });

  it("shows the error when the receipt cannot be downloaded", async () => {
    list.mockResolvedValue({ data: [txn()], error: null });
    receipt.mockResolvedValue({ error: "Receipt not found." });
    render(<Transactions />);
    fireEvent.click(await screen.findByRole("button", { name: /Download receipt/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Receipt not found."));
  });
});
