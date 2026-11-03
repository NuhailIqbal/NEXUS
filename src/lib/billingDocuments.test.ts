import { describe, expect, it } from "vitest";
import { formatInvoiceAmount, formatUsd, hasReceipt } from "./billingDocuments";

describe("money and receipts", () => {
  it("formats dollars", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(-3)).toBe("-$3.00");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats Stripe cents", () => {
    expect(formatInvoiceAmount(5000, "usd")).toBe("$50.00");
  });

  it("only a top-up that added money has a receipt", () => {
    expect(hasReceipt({ kind: "topup", amount: 50 })).toBe(true);
    expect(hasReceipt({ kind: "promo", amount: 20 })).toBe(false);
    expect(hasReceipt({ kind: "call", amount: -1 })).toBe(false);
    expect(hasReceipt({ kind: "topup", amount: 0 })).toBe(false);
  });
});
