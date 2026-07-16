import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, Bot, Phone, Rocket, Users, PhoneIncoming, BarChart3, Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/services/api";

type ChecklistKey = "agent" | "phone" | "contacts" | "campaign" | "inbound" | "analytics";

type ChecklistItem = {
  key: ChecklistKey;
  title: string;
  description: string;
  time: string;
  icon: keyof typeof ICONS;
  href: string;
};

const ICONS = { Bot, Phone, Rocket, Users, PhoneIncoming, BarChart3 } as const;

const SETUP: ChecklistItem[] = [
  { key: "agent",     title: "Create your first AI Agent",        description: "Configure an agent for lead qualification", time: "5 min",  icon: "Bot",           href: "/dashboard/ai-agents/create" },
  { key: "phone",     title: "Get a phone number",                description: "Provision a number for inbound or outbound calls", time: "2 min",  icon: "Phone",         href: "/dashboard/telephony/phone-numbers" },
  { key: "contacts",  title: "Add your contacts",                 description: "Import or add contacts to call", time: "3 min",  icon: "Users",         href: "/dashboard/database/contacts" },
  { key: "campaign",  title: "Launch your first campaign",        description: "Start a dialer campaign with your agent", time: "10 min", icon: "Rocket",        href: "/dashboard/telephony/campaigns" },
  { key: "inbound",   title: "Set up an inbound receptionist",    description: "Let an AI agent answer incoming calls", time: "5 min",  icon: "PhoneIncoming", href: "/dashboard/telephony/inbound" },
  { key: "analytics", title: "Review your analytics",             description: "Track KPIs across channels and campaigns", time: "3 min",  icon: "BarChart3",     href: "/dashboard/analytics/channel" },
];

const QuickSetup = () => {
  const { user } = useAuth();
  const [done, setDone] = useState<Record<ChecklistKey, boolean>>({
    agent: false, phone: false, contacts: false, campaign: false, inbound: false, analytics: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [agents, phones, contacts, camps, inbound, convos] = await Promise.all([
        api.getAgents(),
        api.getPhoneNumbers(),
        api.getContacts(),
        api.getCampaigns(),
        api.getInboundQueues(),
        api.getConversations(),
      ]);
      setDone({
        agent:     (agents.data?.length ?? 0) > 0,
        phone:     (phones.data?.length ?? 0) > 0,
        contacts:  (contacts.data?.length ?? 0) > 0,
        campaign:  (camps.data?.length ?? 0) > 0,
        inbound:   (inbound.data?.length ?? 0) > 0,
        analytics: (convos.data?.length ?? 0) > 0,
      });
      setLoading(false);
    })();
  }, []);

  const completedCount = Object.values(done).filter(Boolean).length;
  const percent = Math.round((completedCount / SETUP.length) * 100);
  const milestones = [0, 20, 40, 60, 80, 100];
  const fullName = (user?.user_metadata?.full_name as string | undefined)?.trim();
  const firstName = fullName
    ? fullName.split(" ")[0]
    : user?.email?.split("@")[0] || "there";

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-background to-background p-6 sm:p-8">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Welcome to EDM Nexus, {firstName} 👋
            </h1>
            <p className="mt-1 text-muted-foreground">
              {completedCount === SETUP.length
                ? "Setup complete you're all set."
                : "Let's get you up and running in minutes."}
            </p>
          </div>
          <CircularProgress percent={loading ? 0 : percent} />
        </div>

        <div className="mt-6">
          <div className="mb-2 flex justify-between text-xs text-muted-foreground">
            <span>Quick Setup Progress</span>
            <span className="font-medium text-foreground">{loading ? "…" : `${percent}%`}</span>
          </div>
          <div className="relative h-2 rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
              style={{ width: `${loading ? 0 : percent}%` }}
            />
            {milestones.map((m) => (
              <div
                key={m}
                className="absolute -top-1 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-background"
                style={{
                  left: `${m}%`,
                  backgroundColor: percent >= m ? "hsl(var(--primary))" : "hsl(var(--muted))",
                }}
              />
            ))}
          </div>
          <div className="mt-2 flex justify-between text-xs text-muted-foreground">
            {milestones.map((m) => (
              <span key={m}>{m}%</span>
            ))}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold text-foreground">Setup Checklist</h2>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Checking your progress…
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {SETUP.map((item) => {
              const Icon = ICONS[item.icon];
              const isDone = done[item.key];
              return (
                <Link
                  key={item.key}
                  to={item.href}
                  className="group block rounded-xl border border-border bg-card p-5 card-interactive"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    {isDone ? (
                      <CheckCircle2 className="h-5 w-5 text-primary" />
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground" />
                    )}
                  </div>
                  <h3 className="mt-4 font-semibold text-foreground">{item.title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                  <div className="mt-4 flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">⏱ {item.time}</span>
                    {isDone ? (
                      <span className="rounded-full bg-success/15 px-2 py-0.5 font-medium text-success">
                        ✓ Done
                      </span>
                    ) : (
                      <span className="font-medium text-primary group-hover:underline">
                        Start →
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

function CircularProgress({ percent }: { percent: number }) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const offset = c - (percent / 100) * c;
  return (
    <div className="relative flex h-24 w-24 items-center justify-center">
      <svg viewBox="0 0 80 80" className="h-24 w-24 -rotate-90">
        <circle cx="40" cy="40" r={r} stroke="hsl(var(--muted))" strokeWidth="6" fill="none" />
        <circle
          cx="40"
          cy="40"
          r={r}
          stroke="hsl(var(--primary))"
          strokeWidth="6"
          fill="none"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-xl font-bold text-foreground">{percent}%</div>
        <div className="text-[10px] uppercase text-muted-foreground">complete</div>
      </div>
    </div>
  );
}

export default QuickSetup;
