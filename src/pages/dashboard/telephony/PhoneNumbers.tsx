import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Phone, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CreatePhoneNumberDialog } from "@/components/telephony/CreatePhoneNumberDialog";
import { RowActions } from "@/components/dashboard/RowActions";
import { api } from "@/services/api";
import { toast } from "sonner";

type Num = {
  id: string;
  number: string;
  status: string;
  agent_id: string;
  provider: string;
  vapi_phone_id: string;
  created_at: string;
  monthly_cost?: number;
  next_billing_at?: string | null;
  suspended_for_balance?: boolean;
};

// Real recurring-billing renewal date (next_billing_at). NULL for free VAPI numbers.
function numberExpiry(nextBillingAt?: string | null) {
  if (!nextBillingAt) return null;
  const d = new Date(nextBillingAt);
  if (isNaN(d.getTime())) return null;
  const daysLeft = Math.floor((d.getTime() - Date.now()) / 86400000);
  return { date: d, daysLeft };
}

type Tab = "all" | "inbound" | "outbound" | "unused";

const PhoneNumbers = () => {
  const [open, setOpen] = useState(false);
  const [numbers, setNumbers] = useState<Num[]>([]);
  const [agentsById, setAgentsById] = useState<Map<string, string>>(new Map());
  const [outboundIds, setOutboundIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("all");

  const [testTarget, setTestTarget] = useState<Num | null>(null);
  const [testLog, setTestLog] = useState<string[]>([]);
  const [settingsTarget, setSettingsTarget] = useState<Num | null>(null);
  const [settingsForm, setSettingsForm] = useState<{ agent_id: string | null; status: string; provider: string }>({ agent_id: "", status: "", provider: "" });

  const fetchNumbers = async () => {
    const [numbersRes, agentsRes, campaignsRes] = await Promise.all([
      api.getPhoneNumbers(), api.getAgents(), api.getCampaigns(),
    ]);
    if (numbersRes.data) setNumbers(Array.isArray(numbersRes.data) ? numbersRes.data : []);
    if (Array.isArray(agentsRes.data))
      setAgentsById(new Map(agentsRes.data.map((a: any) => [a.id, a.name])));
    if (Array.isArray(campaignsRes.data))
      setOutboundIds(new Set(campaignsRes.data.map((c: any) => c.phone_number_id).filter(Boolean)));
    setLoading(false);
  };

  useEffect(() => { fetchNumbers(); }, []);

  // Inbound = actively answering calls (agent assigned). Outbound = referenced by a
  // campaign. Unused = neither — a number just sitting idle, doing nothing.
  const visibleNumbers = useMemo(() => {
    if (tab === "inbound") return numbers.filter((n) => !!n.agent_id);
    if (tab === "outbound") return numbers.filter((n) => outboundIds.has(n.id));
    if (tab === "unused") return numbers.filter((n) => !n.agent_id && !outboundIds.has(n.id));
    return numbers;
  }, [numbers, outboundIds, tab]);

  // Handle the return from Stripe checkout (low-balance number purchase).
  const confirming = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const purchase = params.get("purchase");
    if (!purchase) return;
    const cleanUrl = () => window.history.replaceState({}, "", window.location.pathname);

    if (purchase === "canceled") {
      toast.info("Purchase canceled. No number was created.");
      cleanUrl();
      return;
    }
    if (purchase === "success") {
      const sessionId = params.get("session_id");
      if (!sessionId || confirming.current) { cleanUrl(); return; }
      confirming.current = true;
      const t = toast.loading("Payment received. Provisioning your number…");
      api.confirmPhonePurchase(sessionId).then(({ data, error }) => {
        toast.dismiss(t);
        if (error || !data) toast.error(error || "Could not provision the number after payment.");
        else toast.success(`Number ${data.number || ""} purchased and provisioned.`);
        cleanUrl();
        fetchNumbers();
      });
    }
  }, []);

  const handleDelete = async (n: Num) => {
    const { error } = await api.deletePhoneNumber(n.id);
    if (error) return toast.error(error);
    toast.success("Number released");
    fetchNumbers();
  };

  const openTest = (n: Num) => {
    setTestTarget(n);
    setTestLog([`Selected ${n.number}.`,
      "To test, click 'Place Call' below and enter a phone number to dial.",
      "VAPI will place a real outbound call using this number's assigned agent."]);
  };

  const placeTestCall = async (n: Num, to: string) => {
    if (!n.agent_id) {
      setTestLog((l) => [...l, "Error: no agent assigned to this number. Assign one in Settings first."]);
      return;
    }
    if (!to.trim()) {
      setTestLog((l) => [...l, "Error: enter a target phone number."]);
      return;
    }
    setTestLog((l) => [...l, `Dialing ${to}…`]);
    const { data, error } = await api.makeCall({
      agent_id: n.agent_id,
      phone_number: to.trim(),
      phone_number_id: n.id,
    });
    if (error) {
      setTestLog((l) => [...l, `Call failed: ${error}`]);
    } else {
      setTestLog((l) => [...l, `Call queued (status: ${data?.status ?? "queued"})`]);
    }
  };

  const openSettings = (n: Num) => {
    setSettingsTarget(n);
    setSettingsForm({ agent_id: n.agent_id, status: n.status, provider: n.provider });
  };

  const saveSettings = async () => {
    if (!settingsTarget) return;
    const { error } = await api.updatePhoneNumber(settingsTarget.id, {
      agent_id: settingsForm.agent_id,
      status: settingsForm.status,
      provider: settingsForm.provider,
    });
    if (error) return toast.error(error);
    toast.success("Number updated");
    setSettingsTarget(null);
    fetchNumbers();
  };

  const emptyMessage =
    tab === "inbound" ? "No inbound numbers." :
    tab === "outbound" ? "No outbound numbers." :
    tab === "unused" ? "No unused numbers." :
    "No phone numbers found.";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Phone Numbers</h1>
          <p className="text-sm text-muted-foreground">Every number across inbound and outbound use, in one place.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="mr-2 h-4 w-4" />Buy Number</Button>
      </div>

      <div className="flex items-center gap-6 border-b border-border">
        {([
          { key: "all", label: "All" },
          { key: "inbound", label: "Inbound" },
          { key: "outbound", label: "Outbound" },
          { key: "unused", label: "Unused" },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`relative py-3 text-sm font-medium ${tab === t.key ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
            {tab === t.key && <span className="absolute inset-x-0 -bottom-px h-0.5 bg-primary" />}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Number</th>
              <th className="px-4 py-3">Used In</th>
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Assigned Agent</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Purchased</th>
              <th className="px-4 py-3">Expires</th>
              <th className="px-4 py-3 w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">Loading...</td>
              </tr>
            ) : visibleNumbers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">{emptyMessage}</td>
              </tr>
            ) : (
              visibleNumbers.map((n) => (
                <tr key={n.id} className="border-t border-border bg-card/30">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-mono text-foreground">
                      <Phone className="h-4 w-4 text-primary" /> {n.number}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {n.agent_id && (
                        <span className="rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">Inbound</span>
                      )}
                      {outboundIds.has(n.id) && (
                        <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">Outbound</span>
                      )}
                      {!n.agent_id && !outboundIds.has(n.id) && (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">{n.provider}</td>
                  <td className="px-4 py-3 text-muted-foreground">{agentsById.get(n.agent_id) || (n.agent_id ? "Unknown agent" : "—")}</td>
                  <td className="px-4 py-3">
                    <NumberStatus num={n} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {n.created_at ? new Date(n.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td className="px-4 py-3">
                    {(() => {
                      const e = numberExpiry(n.next_billing_at);
                      if (!e) return <span className="text-muted-foreground">—</span>;
                      const expired = e.daysLeft < 0;
                      const dueSoon = e.daysLeft >= 0 && e.daysLeft <= 5;
                      return (
                        <>
                          <div className="text-foreground">{e.date.toLocaleDateString()}</div>
                          <div className={`text-xs ${expired ? "text-destructive font-medium" : dueSoon ? "text-yellow-500" : "text-muted-foreground"}`}>
                            {expired ? "expired" : `${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"} left`}
                          </div>
                        </>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3">
                    <RowActions
                      onTest={() => openTest(n)}
                      onSettings={() => openSettings(n)}
                      onDelete={() => handleDelete(n)}
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <CreatePhoneNumberDialog
        open={open}
        onOpenChange={setOpen}
        onCreate={async (d) => {
          const payload: Record<string, any> = {
            status: d.active ? "Active" : "Inactive",
            provider: d.serviceProvider,
          };
          if (d.agentId) payload.agent_id = d.agentId;
          // Twilio: if the wallet has ≥ $3 it's deducted from balance; otherwise the
          // backend returns a Stripe checkout URL to pay for this number directly.
          const { data, error } = await api.createPhoneNumber(payload);
          if (error) return toast.error(error);
          if (data?.checkout_url) {
            window.location.href = data.checkout_url;
            return;
          }
          toast.success(`Phone number ${data?.number || ""} created`);
          fetchNumbers();
        }}
      />

      {/* Place test call modal */}
      <TestCallDialog
        target={testTarget}
        log={testLog}
        onPlace={placeTestCall}
        onClose={() => setTestTarget(null)}
      />

      {/* Settings modal */}
      <Dialog open={!!settingsTarget} onOpenChange={(o) => !o && setSettingsTarget(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Number Settings</DialogTitle>
            <DialogDescription>Reassign agent or change status.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Assigned Agent</Label>
              <Select
                value={settingsForm.agent_id || "__none__"}
                onValueChange={(v) => setSettingsForm((f) => ({ ...f, agent_id: v === "__none__" ? null : v }))}
              >
                <SelectTrigger><SelectValue placeholder="Select an agent" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">No agent assigned</SelectItem>
                  {Array.from(agentsById.entries()).map(([id, name]) => (
                    <SelectItem key={id} value={id}>{name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Input value={settingsForm.provider} onChange={(e) => setSettingsForm((f) => ({ ...f, provider: e.target.value }))} />
              </div>
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={settingsForm.status} onValueChange={(v) => setSettingsForm((f) => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsTarget(null)}>Cancel</Button>
            <Button onClick={saveSettings}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const ACTIVATION_SECS = 120;

function NumberStatus({ num }: { num: Num }) {
  const [remaining, setRemaining] = useState<number>(() => {
    if ((num.provider || "").toLowerCase() !== "vapi" || !num.vapi_phone_id || !num.created_at) return 0;
    const elapsed = Math.floor((Date.now() - new Date(num.created_at).getTime()) / 1000);
    return Math.max(0, ACTIVATION_SECS - elapsed);
  });
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (remaining <= 0) return;
    timerRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) { clearInterval(timerRef.current!); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, []);

  if (remaining > 0) {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-0.5 text-xs font-medium text-yellow-500">
        <Clock className="h-3 w-3 animate-pulse" />
        Activating {m}:{String(s).padStart(2, "0")}
      </span>
    );
  }

  if (num.suspended_for_balance) {
    return <Badge variant="destructive">Suspended — add funds</Badge>;
  }

  return <Badge variant={num.status === "Active" ? "default" : "secondary"}>{num.status}</Badge>;
}

function TestCallDialog({
  target, log, onPlace, onClose,
}: {
  target: Num | null;
  log: string[];
  onPlace: (n: Num, to: string) => Promise<void>;
  onClose: () => void;
}) {
  const [to, setTo] = useState("");
  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Place test call from {target?.number}</DialogTitle>
          <DialogDescription>This dials a real number through VAPI using the agent assigned to this number.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Target phone number</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+15551234567" />
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3 font-mono text-xs space-y-1 max-h-56 overflow-y-auto">
            {log.map((l, i) => <div key={i}>{l}</div>)}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={() => target && onPlace(target, to)} disabled={!to.trim()}>Place Call</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PhoneNumbers;
