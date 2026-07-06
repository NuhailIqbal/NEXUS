import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Eye, Plus, Settings, User, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/services/api";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (data: { basic: BasicInfo; custom: Record<string, string> }) => void;
};

type BasicInfo = {
  phone: string;
  email: string;
  name: string;
  timezone: string;
  list_id: string;
};

type CustomField = { key: string; label: string; placeholder?: string; type?: "text" | "yesno" };

const CUSTOM_FIELDS: CustomField[] = [
  { key: "first_name", label: "First Name", placeholder: "first_name" },
  { key: "last_name", label: "Last Name", placeholder: "last_name" },
  { key: "company", label: "Company", placeholder: "company" },
  { key: "address", label: "Address", placeholder: "address" },
  { key: "zip", label: "Zip", placeholder: "zip" },
  { key: "state", label: "State", placeholder: "state" },
  { key: "country", label: "Country", placeholder: "country" },
  { key: "language", label: "Language", placeholder: "language" },
  { key: "lead_status", label: "Lead Status", placeholder: "lead_status" },
  { key: "do_not_contact", label: "Do Not Contact", type: "yesno" },
  { key: "is_qualified", label: "Is Qualified", type: "yesno" },
  { key: "tcpa_consent", label: "TCPA Consent", type: "yesno" },
];

const TIMEZONES = ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Berlin", "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];

export function AddContactDialog({ open, onOpenChange, onCreate }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [basic, setBasic] = useState<BasicInfo>({ phone: "", email: "", name: "", timezone: "UTC", list_id: "" });
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (open) {
      api.getLists().then(({ data }) => setLists((data as any[]) ?? []));
    }
  }, [open]);

  const progress = useMemo(() => Math.round((step / 3) * 100), [step]);

  const reset = () => {
    setStep(1);
    setBasic({ phone: "", email: "", name: "", timezone: "UTC", list_id: "" });
    setCustom({});
  };

  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const next = () => {
    if (step === 1) {
      if (!basic.name.trim()) return toast.error("Name is required");
      if (!basic.phone.trim() && !basic.email.trim()) return toast.error("Phone or email is required");
    }
    if (step < 3) setStep((s) => (s + 1) as 1 | 2 | 3);
  };

  const submit = () => {
    onCreate?.({ basic, custom });
    toast.success("Contact created");
    close(false);
  };

  const setCf = (k: string, v: string) => setCustom((c) => ({ ...c, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-4xl gap-0 p-0 sm:rounded-xl [&>button]:hidden">
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
            <span>Step {step} of 3</span>
            <span>{progress}% Complete</span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 px-6 pt-4">
          <TabPill active={step === 1} icon={<User className="h-4 w-4" />} label="Basic Info" />
          <TabPill active={step === 2} icon={<Settings className="h-4 w-4" />} label="Custom fields" />
          <TabPill active={step === 3} icon={<Eye className="h-4 w-4" />} label="Review" />
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-6">
          {step === 1 && (
            <div>
              <div className="text-center">
                <h3 className="text-lg font-semibold">Basic Information</h3>
                <p className="text-sm text-muted-foreground">Enter the lead's basic contact information</p>
              </div>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                <Field label="Phone">
                  <Input value={basic.phone} onChange={(e) => setBasic((b) => ({ ...b, phone: e.target.value }))} placeholder="Please provide customer phone" />
                </Field>
                <Field label="Email">
                  <Input type="email" value={basic.email} onChange={(e) => setBasic((b) => ({ ...b, email: e.target.value }))} placeholder="Please provide customer email" />
                </Field>
                <Field label="Name">
                  <Input value={basic.name} onChange={(e) => setBasic((b) => ({ ...b, name: e.target.value }))} placeholder="Please provide customer name" />
                </Field>
                <Field label="Timezone">
                  <select value={basic.timezone} onChange={(e) => setBasic((b) => ({ ...b, timezone: e.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    {TIMEZONES.map((tz) => (<option key={tz} value={tz}>{tz}</option>))}
                  </select>
                </Field>
                <Field label="List">
                  <select value={basic.list_id} onChange={(e) => setBasic((b) => ({ ...b, list_id: e.target.value }))} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                    <option value="">No list (unassigned)</option>
                    {lists.map((l) => (<option key={l.id} value={l.id}>{l.name}</option>))}
                  </select>
                </Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="text-center">
                <h3 className="text-lg font-semibold">Custom Field Values</h3>
                <p className="text-sm text-muted-foreground">Fill in the custom field values for this lead</p>
              </div>
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
                {CUSTOM_FIELDS.map((f) => (
                  <Field key={f.key} label={f.label}>
                    {f.type === "yesno" ? (
                      <select value={custom[f.key] ?? ""} onChange={(e) => setCf(f.key, e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                        <option value="">Please select Yes or No</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    ) : (
                      <Input value={custom[f.key] ?? ""} onChange={(e) => setCf(f.key, e.target.value)} placeholder={f.placeholder} />
                    )}
                  </Field>
                ))}
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="text-center">
                <h3 className="text-lg font-semibold">Review &amp; Submit</h3>
                <p className="text-sm text-muted-foreground">Review the lead information before saving</p>
              </div>
              <div className="mt-6 space-y-4 rounded-lg bg-muted/50 p-5">
                <div>
                  <h4 className="mb-3 font-semibold">Basic Information</h4>
                  <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                    <ReviewRow label="Name" value={basic.name} />
                    <ReviewRow label="Phone" value={basic.phone} />
                    <ReviewRow label="Email" value={basic.email} />
                    <ReviewRow label="Timezone" value={basic.timezone} />
                    <ReviewRow label="List" value={lists.find((l) => l.id === basic.list_id)?.name ?? "Unassigned"} />
                  </div>
                </div>
                <div>
                  <h4 className="mb-3 font-semibold">Custom Fields Information</h4>
                  <div className="grid grid-cols-1 gap-2 text-sm md:grid-cols-2">
                    {Object.entries(custom).filter(([, v]) => v?.trim()).map(([k, v]) => {
                      const def = CUSTOM_FIELDS.find((f) => f.key === k);
                      return <ReviewRow key={k} label={def?.label ?? k} value={v} />;
                    })}
                    {Object.values(custom).filter((v) => v?.trim()).length === 0 && (
                      <p className="text-sm text-muted-foreground">No custom fields filled.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border p-4">
          {step === 1 ? <span /> : (
            <Button variant="outline" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Previous
            </Button>
          )}
          {step < 3 ? (
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
