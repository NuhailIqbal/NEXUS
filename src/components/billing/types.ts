export type BillingStatus = {
  is_active: boolean;
  rate_per_minute: number;
  cost_multiplier: number;
  total_charges: number;
  balance: number;
  auto_recharge_enabled: boolean;
  auto_recharge_threshold: number;
  auto_recharge_amount: number;
};

export type CallCostEntry = {
  id: string;
  direction: string;
  phone: string;
  contact_name: string;
  duration: string;
  duration_seconds: number;
  call_cost: number;
  status: string;
  created_at: string;
};

export type PurchaseTxn = {
  id: string;
  kind: string;
  amount: number;
  balance_after: number | null;
  description: string | null;
  created_at: string;
};

export type PaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
};

export type AppliedPromotion = {
  id: string;
  code: string;
  amount: number;
  created_at: string;
};

export const TOPUP_PRESETS = [20, 50, 100, 250];
export const TOPUP_MIN = 20;
export const TOPUP_MAX = 1000;

export const TXN_LABELS: Record<string, string> = {
  topup: "Top-up",
  phone: "Phone Number",
  admin: "Adjustment",
  promo: "Welcome credit",
  promo_code: "Promo code",
  call: "Call",
  refund: "Refund",
};

export function formatDuration(seconds: number): string {
  if (!seconds) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
