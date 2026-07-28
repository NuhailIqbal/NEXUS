import { useCallback, useEffect, useState } from "react";
import { CreditCard, Loader2, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/services/api";
import { AddCardDialog } from "./AddCardDialog";
import type { PaymentMethod } from "./types";

const PaymentMethods = () => {
  const [cards, setCards] = useState<PaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PaymentMethod | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchCards = useCallback(async () => {
    const { data, error } = await api.getPaymentMethods();
    if (error) toast.error(error);
    if (Array.isArray(data)) setCards(data);
    setLoading(false);
  }, []);

  useEffect(() => { fetchCards(); }, [fetchCards]);

  const makeDefault = async (card: PaymentMethod) => {
    setBusyId(card.id);
    const { error } = await api.setDefaultPaymentMethod(card.id);
    setBusyId(null);
    if (error) return toast.error(error);
    toast.success(`${card.brand} •••• ${card.last4} is now your default`);
    fetchCards();
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const card = pendingDelete;
    setPendingDelete(null);
    setBusyId(card.id);
    const { error } = await api.deletePaymentMethod(card.id);
    setBusyId(null);
    if (error) return toast.error(error);
    toast.success("Payment method removed");
    fetchCards();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading payment methods…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {cards.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 py-14 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <CreditCard className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="font-semibold text-foreground">No payment methods yet</h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Add a card to top up your balance faster and to enable auto recharge.
          </p>
          <Button className="mt-4" onClick={() => setShowAdd(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add payment method
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            {cards.map((card) => (
              <div key={card.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <CreditCard className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="font-medium text-foreground">
                        {card.brand} •••• {card.last4}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Expires {String(card.exp_month).padStart(2, "0")}/{card.exp_year}
                      </div>
                    </div>
                  </div>
                  {card.is_default && <Badge>Default</Badge>}
                </div>
                <div className="mt-4 flex items-center gap-2 border-t border-border pt-3">
                  {!card.is_default && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => makeDefault(card)}
                      disabled={busyId === card.id}
                    >
                      <Star className="mr-1 h-3.5 w-3.5" /> Set as default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto text-destructive hover:text-destructive"
                    onClick={() => setPendingDelete(card)}
                    disabled={busyId === card.id}
                  >
                    {busyId === card.id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <><Trash2 className="mr-1 h-3.5 w-3.5" /> Remove</>}
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Button variant="outline" onClick={() => setShowAdd(true)}>
            <Plus className="mr-2 h-4 w-4" /> Add payment method
          </Button>
        </>
      )}

      <AddCardDialog open={showAdd} onOpenChange={setShowAdd} onAdded={fetchCards} />

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => { if (!o) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this payment method?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete && `${pendingDelete.brand} •••• ${pendingDelete.last4} will be removed from your account. `}
              You can add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default PaymentMethods;
