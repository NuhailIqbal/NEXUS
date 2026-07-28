import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { api } from "@/services/api";
import { TOPUP_PRESETS, TOPUP_MIN, TOPUP_MAX } from "./types";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Starting amount when the dialog opens. */
  defaultAmount?: number;
};

/** Adds funds to the wallet via Stripe hosted Checkout. The user is redirected out and
 *  returns to /dashboard/billing?topup=success, which the Overview tab confirms. */
export function AddFundsDialog({ open, onOpenChange, defaultAmount = 50 }: Props) {
  const [amount, setAmount] = useState(defaultAmount);
  const [submitting, setSubmitting] = useState(false);

  const pay = async () => {
    if (amount < TOPUP_MIN) return toast.error(`Minimum top-up is $${TOPUP_MIN}`);
    setSubmitting(true);
    const { data, error } = await api.topupCheckout(amount);
    setSubmitting(false);
    if (error || !data?.checkout_url) return toast.error(error || "Could not start checkout");
    window.location.href = data.checkout_url;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add to credit balance</DialogTitle>
          <DialogDescription>
            Load your account balance. It's used for calls and phone numbers.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-2">
            {TOPUP_PRESETS.map((amt) => (
              <Button
                key={amt}
                type="button"
                variant={amount === amt ? "default" : "outline"}
                onClick={() => setAmount(amt)}
              >
                ${amt}
              </Button>
            ))}
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-foreground">Custom amount (USD)</label>
            <Input
              type="number"
              min={TOPUP_MIN}
              max={TOPUP_MAX}
              value={amount}
              onChange={(e) => setAmount(parseFloat(e.target.value) || 0)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Minimum ${TOPUP_MIN}. You'll pay securely via Stripe.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={pay} disabled={submitting || amount < TOPUP_MIN}>
            {submitting ? (
              <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Redirecting…</>
            ) : (
              <>Pay ${amount.toFixed(2)}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
