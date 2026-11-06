/**
 * Admin portal "Partners" section: create and manage referral partners, set each one's commission (a percentage of
 * profit or a fixed amount per verified signup), and see for each partner what their referred users were billed vs
 * what the platform paid (platform cost), the profit delta between the two, the commission owed and what the
 * platform keeps. A partner's detail view lists every referred account with the same three numbers, the payment
 * ledger (record a payment, edit its description, void it with a reason; paid vs still owed) and a live activity
 * feed. The list page also holds the commission reports by period (components/partners/CommissionReport.tsx). Rendered by pages/dashboard/Admin.tsx, which passes its own "view as user" handler.
 * Data: GET/POST /admin/partners, GET/PATCH /admin/partners/{id}, GET /admin/partners/activity, GET /admin/partners/reports,
 * POST/PATCH /admin/partners/{id}/payouts[/{pid}[/void]] (services/partners.py).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Ban, Banknote, Copy, Eye, Loader2, Pause, Pencil, Play, Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import ActivityFeed from "@/components/partners/ActivityFeed";
import CommissionReport from "@/components/partners/CommissionReport";
import { api } from "@/services/api";
import { moneyOrDash } from "@/lib/leadRoi";
import { cn } from "@/lib/utils";
import {
  balanceStatus, checkPayoutAmount, commissionExplainer, parseCommission, payoutDate, referralUrl, todayISO,
  type AdminPartnerTotals, type AdminPayout, type CommissionType, type PartnerInfo, type PartnerSignup,
} from "@/lib/partners";
import { mainAppOrigin } from "@/lib/adminHost";

type PartnerRow = PartnerInfo & { totals: AdminPartnerTotals };
type PartnerDetail = PartnerRow & { signups: PartnerSignup[]; payouts: AdminPayout[] };
type ListData = { partners: PartnerRow[]; totals: AdminPartnerTotals };

const Tile = ({ label, value, tone }: { label: string; value: string | number; tone?: "profit" | "warn" | "neutral" }) => (
  <div className={cn(
    "rounded-xl border bg-card p-5",
    tone === "profit" ? "border-green-500/50 bg-green-500/5" : tone === "warn" ? "border-amber-500/50 bg-amber-500/5" : "border-border",
  )}>
    <div className={cn("text-2xl font-bold", tone === "profit" ? "text-green-500" : tone === "warn" ? "text-amber-500" : "text-foreground")}>{value}</div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

/**
 * The money tiles shared by the list (all partners) and a partner's detail. First row is the platform's side (billed,
 * cost, the profit between them, what it keeps); second row is the commission: earned, actually paid, still owed.
 */
const MoneyTiles = ({ t }: { t: AdminPartnerTotals }) => {
  const balance = balanceStatus(t.owed);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Tile label="Billed to users" value={moneyOrDash(t.billed)} />
        <Tile label="Platform cost" value={moneyOrDash(t.platform_cost)} />
        <Tile label="Profit (billed − cost)" value={moneyOrDash(t.profit)} tone="profit" />
        <Tile label="Platform keeps (profit − commission earned)" value={moneyOrDash(t.net_profit)} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Tile label="Commission earned" value={moneyOrDash(t.commission)} />
        <Tile label="Paid out to partners" value={moneyOrDash(t.paid)} />
        <Tile
          label={balance === "overpaid" ? "Overpaid (rate was lowered after paying)" : "Still owed"}
          value={moneyOrDash(Math.abs(t.owed))} tone={balance === "owed" || balance === "overpaid" ? "warn" : "neutral"}
        />
      </div>
    </div>
  );
};

const profitClass = (n: number) => (n > 0 ? "text-green-500" : n < 0 ? "text-destructive" : "text-muted-foreground");
const owedClass = (n: number) => (n > 0 ? "font-semibold text-amber-500" : n < 0 ? "font-semibold text-destructive" : "text-muted-foreground");

const copyLink = (path: string) => {
  navigator.clipboard.writeText(referralUrl(mainAppOrigin(), path));
  toast.success("Referral link copied");
};

type Props = { onViewAs: (userId: string, email: string) => void };

export default function PartnersAdmin({ onViewAs }: Props) {
  const [list, setList] = useState<ListData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await api.getAdminPartners();
    if (error || !data) return toast.error(error || "Could not load partners");
    setList(data);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (selected) {
    return <PartnerDetailView id={selected} onBack={() => { setSelected(null); load(); }} onViewAs={onViewAs} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Referral Partners</h1>
          <p className="text-sm text-muted-foreground">
            Each partner gets a unique signup link. Their users&apos; call billing, what the platform paid for it, and the profit between the two, are shown below.
          </p>
        </div>
        <Button className="gap-2" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New partner</Button>
      </div>

      {!list ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>
      ) : (
        <>
          <MoneyTiles t={list.totals} />
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1180px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Partner</th>
                    <th className="px-4 py-3">Commission</th>
                    <th className="px-4 py-3 text-right">Signups</th>
                    <th className="px-4 py-3 text-right">Billed</th>
                    <th className="px-4 py-3 text-right">Platform cost</th>
                    <th className="px-4 py-3 text-right">Profit</th>
                    <th className="px-4 py-3 text-right">Earned</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3 text-right">Still owed</th>
                    <th className="px-4 py-3 text-right">Platform keeps</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {list.partners.length === 0 ? (
                    <tr><td colSpan={11} className="px-4 py-10 text-center text-muted-foreground">No partners yet. Create the first one.</td></tr>
                  ) : list.partners.map((p) => (
                    <tr key={p.id} className="border-t border-border bg-card/30">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{p.name}</span>
                          <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status === "active" ? "Active" : "Paused"}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">{p.email}</div>
                        <button type="button" onClick={() => copyLink(p.referral_path)} className="mt-1 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
                          {p.code} <Copy className="h-3 w-3" />
                        </button>
                      </td>
                      <td className="px-4 py-3 text-foreground">{p.commission_label}</td>
                      <td className="px-4 py-3 text-right">{p.totals.signups} <span className="text-xs text-muted-foreground">({p.totals.verified} verified)</span></td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.billed)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.platform_cost)}</td>
                      <td className={cn("px-4 py-3 text-right font-semibold", profitClass(p.totals.profit))}>{moneyOrDash(p.totals.profit)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.commission)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.paid)}</td>
                      <td className={cn("px-4 py-3 text-right", owedClass(p.totals.owed))}>{moneyOrDash(p.totals.owed)}</td>
                      <td className="px-4 py-3 text-right">{moneyOrDash(p.totals.net_profit)}</td>
                      <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setSelected(p.id)}>Manage</Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <CommissionReport admin partners={list.partners.map((p) => ({ id: p.id, name: p.name }))} />
          <ActivityFeed load={() => api.getAdminPartnerActivity()} showPartner />
        </>
      )}

      <CreatePartnerDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); load(); setSelected(id); }} />
    </div>
  );
}

/** Commission rule editor shared by the create dialog and the detail view. */
function CommissionFields({ type, value, onType, onValue }: { type: CommissionType; value: string; onType: (t: CommissionType) => void; onValue: (v: string) => void }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Commission type</Label>
          <Select value={type} onValueChange={(v) => onType(v as CommissionType)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">Percentage of profit</SelectItem>
              <SelectItem value="fixed">Fixed per verified signup</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{type === "percent" ? "Percent (0–100)" : "Amount in $"}</Label>
          <Input inputMode="decimal" value={value} onChange={(e) => onValue(e.target.value)} placeholder={type === "percent" ? "20" : "5"} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{commissionExplainer(type)}</p>
    </div>
  );
}

function CreatePartnerDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ name: "", email: "", password: "", code: "", notes: "" });
  const [type, setType] = useState<CommissionType>("percent");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    const commission = parseCommission(type, value);
    if (!form.name.trim() || !form.email.trim()) return toast.error("Name and email are required");
    if (commission === null) return toast.error(type === "percent" ? "Enter a percentage between 0 and 100" : "Enter a dollar amount");
    setBusy(true);
    const { data, error } = await api.createAdminPartner({
      name: form.name.trim(), email: form.email.trim(), password: form.password || undefined,
      code: form.code.trim() || undefined, notes: form.notes.trim() || undefined,
      commission_type: type, commission_value: commission,
    });
    setBusy(false);
    if (error || !data) return toast.error(typeof error === "string" ? error : "Could not create the partner");
    toast.success(`Partner created. Their code is ${data.code}`);
    setForm({ name: "", email: "", password: "", code: "", notes: "" });
    setValue("");
    onCreated(data.id);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New referral partner</DialogTitle>
          <DialogDescription>Creates the partner, their sign-in and a unique referral link.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Partner name</Label><Input value={form.name} onChange={set("name")} placeholder="Acme Affiliates" /></div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Email (their login)</Label><Input type="email" value={form.email} onChange={set("email")} /></div>
            <div className="space-y-1.5"><Label>Password</Label><Input type="password" value={form.password} onChange={set("password")} placeholder="Leave empty if the account exists" /></div>
          </div>
          <CommissionFields type={type} value={value} onType={setType} onValue={setValue} />
          <div className="space-y-1.5">
            <Label>Custom code (optional)</Label>
            <Input value={form.code} onChange={set("code")} placeholder="Auto-generated if empty. 4–20 letters or digits" className="font-mono" />
          </div>
          <div className="space-y-1.5"><Label>Notes (optional)</Label><Input value={form.notes} onChange={set("notes")} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create partner</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PartnerDetailView({ id, onBack, onViewAs }: { id: string; onBack: () => void; onViewAs: Props["onViewAs"] }) {
  const [p, setP] = useState<PartnerDetail | null>(null);
  const [type, setType] = useState<CommissionType>("percent");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await api.getAdminPartner(id);
    if (error || !data) { toast.error(error || "Could not load the partner"); return; }
    setP(data);
    setType(data.commission_type);
    setValue(String(data.commission_value));
  }, [id]);

  useEffect(() => { load(); }, [load]);
  // Usage keeps arriving, so the money and the per-user rows refresh quietly.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      api.getAdminPartner(id).then(({ data }) => data && setP(data));
    }, 15000);
    return () => clearInterval(t);
  }, [id]);

  if (!p) return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…</div>;

  const dirty = type !== p.commission_type || Number(value) !== p.commission_value;

  const save = async (patch: Record<string, unknown>, msg: string) => {
    setSaving(true);
    const { error } = await api.updateAdminPartner(id, patch);
    setSaving(false);
    if (error) return toast.error(typeof error === "string" ? error : "Could not save");
    toast.success(msg);
    load();
  };

  const saveCommission = () => {
    const v = parseCommission(type, value);
    if (v === null) return toast.error(type === "percent" ? "Enter a percentage between 0 and 100" : "Enter a dollar amount");
    save({ commission_type: type, commission_value: v }, "Commission updated");
  };

  return (
    <div className="space-y-6">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> All partners
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">{p.name}</h1>
            <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status === "active" ? "Active" : "Paused"}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{p.email}</p>
        </div>
        <Button
          variant="outline" className="gap-2" disabled={saving}
          onClick={() => save({ status: p.status === "active" ? "paused" : "active" }, p.status === "active" ? "Partner paused" : "Partner reactivated")}
        >
          {p.status === "active" ? <><Pause className="h-4 w-4" /> Pause</> : <><Play className="h-4 w-4" /> Reactivate</>}
        </Button>
      </div>

      <div className="max-w-xl space-y-2">
        <Label>Referral link</Label>
        <div className="flex gap-2">
          <Input readOnly value={referralUrl(mainAppOrigin(), p.referral_path)} className="min-w-0 font-mono text-sm" />
          <Button type="button" className="gap-2" onClick={() => copyLink(p.referral_path)}><Copy className="h-4 w-4" /> Copy</Button>
        </div>
        {p.status === "paused" && <p className="text-xs text-muted-foreground">Paused: this link still opens the signup page but no new signup is credited to the partner, and they cannot use "View as".</p>}
      </div>

      <MoneyTiles t={p.totals} />
      <p className="-mt-3 text-xs text-muted-foreground">
        Call usage of this partner&apos;s referred accounts only. Profit is billed minus what the platform paid its providers; a call with no reported provider cost counts fully as profit.
      </p>

      <div className="max-w-xl space-y-3 rounded-xl border border-border bg-card/40 p-5">
        <h2 className="text-lg font-semibold text-foreground">Commission level</h2>
        <CommissionFields type={type} value={value} onType={setType} onValue={setValue} />
        <p className="text-xs text-muted-foreground">
          A change applies to the partner&apos;s whole history, so what they have earned is recalculated at the new rate.
          Payments already recorded are not changed, so lowering the rate after paying can leave the partner overpaid.
        </p>
        <Button onClick={saveCommission} disabled={!dirty || saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save commission</Button>
      </div>

      <PayoutsSection partnerId={id} totals={p.totals} payouts={p.payouts} onChanged={load} />

      <div>
        <h2 className="mb-3 text-lg font-semibold text-foreground">Referred accounts ({p.signups.length})</h2>
        <div className="overflow-hidden rounded-xl border border-border">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">User</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Signed up</th>
                  <th className="px-4 py-3 text-right">Calls</th>
                  <th className="px-4 py-3 text-right">Billed</th>
                  <th className="px-4 py-3 text-right">Platform cost</th>
                  <th className="px-4 py-3 text-right">Profit</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {p.signups.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">Nobody has signed up through this link yet.</td></tr>
                ) : p.signups.map((s) => (
                  <tr key={s.user_id} className="border-t border-border bg-card/30">
                    <td className="px-4 py-3"><div className="break-all font-medium text-foreground">{s.email}</div>{s.full_name && <div className="text-xs text-muted-foreground">{s.full_name}</div>}</td>
                    <td className="px-4 py-3"><Badge variant={s.status === "verified" ? "default" : "secondary"}>{s.status === "verified" ? "Verified" : "Pending"}</Badge></td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{new Date(s.created_at).toLocaleDateString()}</td>
                    <td className="px-4 py-3 text-right">{s.calls}</td>
                    <td className="px-4 py-3 text-right">{moneyOrDash(s.billed)}</td>
                    <td className="px-4 py-3 text-right">{moneyOrDash(s.platform_cost ?? 0)}</td>
                    <td className={cn("px-4 py-3 text-right font-semibold", profitClass(s.profit ?? 0))}>{moneyOrDash(s.profit ?? 0)}</td>
                    <td className="px-4 py-3 text-right">
                      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onViewAs(s.user_id, s.email)}><Eye className="h-3.5 w-3.5" /> View as</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ActivityFeed load={() => api.getAdminPartnerActivity(id)} />
    </div>
  );
}

type PayoutDialogState = { kind: "record" } | { kind: "edit"; payout: AdminPayout } | { kind: "void"; payout: AdminPayout } | null;

/** One partner's payment ledger: earned / paid / still owed, every payment, and record / edit / void. */
function PayoutsSection({ partnerId, totals, payouts, onChanged }: { partnerId: string; totals: AdminPartnerTotals; payouts: AdminPayout[]; onChanged: () => void }) {
  const [dialog, setDialog] = useState<PayoutDialogState>(null);
  const balance = balanceStatus(totals.owed);
  const valid = payouts.filter((x) => x.status === "paid").length;
  const done = () => { setDialog(null); onChanged(); };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Payments ({valid})</h2>
          <p className="text-xs text-muted-foreground">
            Earned {moneyOrDash(totals.commission)} · Paid {moneyOrDash(totals.paid)} ·{" "}
            {balance === "overpaid" ? `Overpaid ${moneyOrDash(Math.abs(totals.owed))}` : `Still owed ${moneyOrDash(totals.owed)}`}
          </p>
        </div>
        <Button className="gap-2" disabled={balance !== "owed"} onClick={() => setDialog({ kind: "record" })}>
          <Banknote className="h-4 w-4" /> Record payment
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Paid on</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Method</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Note</th>
                <th className="px-4 py-3">Recorded by</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {payouts.length === 0 ? (
                <tr><td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">No payments recorded yet.</td></tr>
              ) : payouts.map((x) => (
                <tr key={x.id} className={cn("border-t border-border bg-card/30", x.status === "void" && "text-muted-foreground")}>
                  <td className="whitespace-nowrap px-4 py-3">{payoutDate(x.paid_on)}</td>
                  <td className={cn("px-4 py-3 text-right font-semibold", x.status === "void" && "line-through")}>{moneyOrDash(x.amount)}</td>
                  <td className="px-4 py-3">{x.method || "—"}</td>
                  <td className="break-all px-4 py-3">{x.reference || "—"}</td>
                  <td className="max-w-[220px] break-words px-4 py-3">{x.note || "—"}</td>
                  <td className="px-4 py-3">{x.created_by || "—"}</td>
                  <td className="px-4 py-3">
                    {x.status === "paid" ? <Badge>Paid</Badge> : (
                      <>
                        <Badge variant="secondary">Void</Badge>
                        <div className="mt-1 max-w-[200px] break-words text-xs">{x.void_reason}{x.voided_by ? ` · ${x.voided_by}` : ""}</div>
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {x.status === "paid" && (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDialog({ kind: "edit", payout: x })}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setDialog({ kind: "void", payout: x })}><Ban className="h-3.5 w-3.5" /> Void</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {dialog?.kind === "record" && <RecordPayoutDialog partnerId={partnerId} owed={totals.owed} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "edit" && <EditPayoutDialog partnerId={partnerId} payout={dialog.payout} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === "void" && <VoidPayoutDialog partnerId={partnerId} payout={dialog.payout} onClose={() => setDialog(null)} onDone={done} />}
    </div>
  );
}

const PAYOUT_METHODS = ["Bank transfer", "PayPal", "Wire", "Check", "Other"];

function RecordPayoutDialog({ partnerId, owed, onClose, onDone }: { partnerId: string; owed: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(owed.toFixed(2));
  const [paidOn, setPaidOn] = useState(todayISO());
  const [method, setMethod] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const check = checkPayoutAmount(amount, owed);

  const submit = async () => {
    if (check.error || check.value === null) return toast.error(check.error ?? "Enter the amount paid.");
    if (!paidOn) return toast.error("Pick the date the payment was made");
    setBusy(true);
    const { error } = await api.recordAdminPartnerPayout(partnerId, {
      amount: check.value, paid_on: paidOn, method: method.trim() || undefined,
      reference: reference.trim() || undefined, note: note.trim() || undefined,
    });
    setBusy(false);
    if (error) return toast.error(typeof error === "string" ? error : "Could not record the payment");
    toast.success(`Recorded a payment of ${moneyOrDash(check.value)}`);
    onDone();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
          <DialogDescription>Log money you have already sent to this partner. It does not move any money itself.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Amount paid ($)</Label>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {amount.trim() !== "" && check.error
                ? <p className="text-xs text-destructive">{check.error}</p>
                : <p className="text-xs text-muted-foreground">Still owed: {moneyOrDash(owed)}. You cannot pay more than this.</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Paid on</Label>
              <Input type="date" value={paidOn} max={todayISO()} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Method (optional)</Label>
              <Input list="payout-methods" value={method} maxLength={40} onChange={(e) => setMethod(e.target.value)} placeholder="Bank transfer" />
              <datalist id="payout-methods">{PAYOUT_METHODS.map((m) => <option key={m} value={m} />)}</datalist>
            </div>
            <div className="space-y-1.5">
              <Label>Reference (optional)</Label>
              <Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Note (optional, only you see it)</Label>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy || check.value === null}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Record payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditPayoutDialog({ partnerId, payout, onClose, onDone }: { partnerId: string; payout: AdminPayout; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState(payout.method);
  const [reference, setReference] = useState(payout.reference);
  const [note, setNote] = useState(payout.note);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const { error } = await api.updateAdminPartnerPayout(partnerId, payout.id, { method: method.trim(), reference: reference.trim(), note: note.trim() });
    setBusy(false);
    if (error) return toast.error(typeof error === "string" ? error : "Could not save the payment");
    toast.success("Payment updated");
    onDone();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit payment details</DialogTitle>
          <DialogDescription>
            {moneyOrDash(payout.amount)} paid on {payoutDate(payout.paid_on)}. The amount and date are fixed: to change them, void this payment and record a new one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Method</Label>
              <Input list="payout-methods" value={method} maxLength={40} onChange={(e) => setMethod(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Reference</Label>
              <Input value={reference} maxLength={120} onChange={(e) => setReference(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Note (only you see it)</Label>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VoidPayoutDialog({ partnerId, payout, onClose, onDone }: { partnerId: string; payout: AdminPayout; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const usable = reason.trim().length >= 3;

  const submit = async () => {
    setBusy(true);
    const { error } = await api.voidAdminPartnerPayout(partnerId, payout.id, reason.trim());
    setBusy(false);
    if (error) return toast.error(typeof error === "string" ? error : "Could not void the payment");
    toast.success("Payment voided");
    onDone();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Void this payment?</DialogTitle>
          <DialogDescription>
            {moneyOrDash(payout.amount)} paid on {payoutDate(payout.paid_on)} goes back to &quot;still owed&quot;. It stays in the history, marked void, with your reason.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Reason</Label>
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Bank rejected the transfer" autoFocus />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Keep payment</Button>
          <Button variant="destructive" onClick={submit} disabled={busy || !usable}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Void payment</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
