import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, Plus, User, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { basic: BasicInfo }) => void;
};

type BasicInfo = {
  phone: string;
  email: string;
  name: string;
  list_id: string;
};

export function AddContactDialog({ open, onOpenChange, onCreate }: Props) {
  const [step, setStep] = useState<1 | 2>(1);
  const [basic, setBasic] = useState<BasicInfo>({ phone: "", email: "", name: "", list_id: "" });
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      api.getLists().then(({ data }) => setLists((data as any[]) ?? []));
    }
  }, [open]);

  const progress = useMemo(() => Math.round((step / 2) * 100), [step]);

  const reset = () => {
    setStep(1);
    setBasic({ phone: "", email: "", name: "", list_id: "" });
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const next = () => {
    if (!basic.name.trim()) return toast.error("Name is required");
    if (!basic.phone.trim()) return toast.error("Phone number is required");
    setStep(2);
  };

  const submit = () => {
    onCreate?.({ basic });
    toast.success("Contact created");
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
        <div className="flex items-start justify-between border-b border-border p-5">
          <div className="flex items-center gap-2">
            <User className="h-5 w-5" />
            <h2 className="text-lg font-semibold">Add New Contact</h2>
          </div>
          <button onClick={() => close(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6 pt-4">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Step {step} of 2</span>
            <span>{progress}% Complete</span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 px-6 pt-4">
          <TabPill active={step === 1} icon={<User className="h-4 w-4" />} label="Basic Info" />
          <TabPill active={step === 2} icon={<Eye className="h-4 w-4" />} label="Review" />
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6">
          {step === 1 && (
            <div>
              <div className="text-center">
                <h3 className="text-lg font-semibold">Basic Information</h3>
                <p className="text-sm text-muted-foreground">Enter the lead's basic contact information</p>
              </div>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Phone *">
                  <Input value={basic.phone} onChange={(e) => setBasic((b) => ({ ...b, phone: e.target.value }))} placeholder="Please provide customer phone" />
                </Field>
                <Field label="Email">
                  <Input type="email" value={basic.email} onChange={(e) => setBasic((b) => ({ ...b, email: e.target.value }))} placeholder="Please provide customer email" />
                </Field>
                <Field label="Name">
                  <Input value={basic.name} onChange={(e) => setBasic((b) => ({ ...b, name: e.target.value }))} placeholder="Please provide customer name" />
                </Field>
                <Field label="List">
                  <Select
                    value={basic.list_id || "__none__"}
                    onValueChange={(v) => setBasic((b) => ({ ...b, list_id: v === "__none__" ? "" : v }))}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">No list (unassigned)</SelectItem>
                      {lists.map((l) => (<SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="text-center">
                <h3 className="text-lg font-semibold">Review &amp; Submit</h3>
                <p className="text-sm text-muted-foreground">Review the lead information before saving</p>
              </div>
              <div className="mt-6 space-y-4 rounded-lg bg-muted/50 p-5">
                <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                  <ReviewRow label="Name" value={basic.name} />
                  <ReviewRow label="Phone" value={basic.phone} />
                  <ReviewRow label="Email" value={basic.email} />
                  <ReviewRow label="List" value={lists.find((l) => l.id === basic.list_id)?.name ?? "Unassigned"} />
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          {step === 1 ? <span /> : (
            <Button variant="outline" onClick={() => setStep(1)}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
          )}
          {step < 2 ? (
            <Button onClick={next} className="bg-primary text-primary-foreground hover:opacity-90">
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={submit} className="bg-primary text-primary-foreground hover:opacity-90">
              <Plus className="mr-1 h-4 w-4" /> Create
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabPill({ active, icon, label }: { active: boolean; icon: React.ReactNode; label: string }) {
  return (
    <div className={`flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium ${active ? "border-foreground bg-background" : "border-transparent bg-muted text-muted-foreground"}`}>
      {icon}
      <span>{label}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-semibold">{label}</label>
      {children}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <span className="font-semibold">{label}:</span>{" "}
      <span className="text-muted-foreground">{value || " "}</span>
    </div>
  );
}
