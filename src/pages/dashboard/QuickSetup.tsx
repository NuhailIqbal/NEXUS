import { CheckCircle2, Circle, Bot, Phone, Rocket, Plug, Workflow, BarChart3 } from "lucide-react";
const setupChecklist = [
  { id: 1, title: "Create your first AI Agent", description: "Configure an agent for lead qualification", time: "5 min", completed: false, icon: "Bot" },
  { id: 2, title: "Get a phone number", description: "Provision a number for inbound or outbound calls", time: "2 min", completed: false, icon: "Phone" },
  { id: 3, title: "Launch your first campaign", description: "Start a dialer campaign with your agent", time: "10 min", completed: false, icon: "Rocket" },
  { id: 4, title: "Integrate to your systems", description: "Connect CRM, telephony, and data sources", time: "8 min", completed: false, icon: "Plug" },
  { id: 5, title: "Set your first automation flow", description: "Build a no-code automation workflow", time: "12 min", completed: false, icon: "Workflow" },
  { id: 6, title: "Review your analytics", description: "Track KPIs across channels and campaigns", time: "3 min", completed: false, icon: "BarChart3" },
];
import { useAuth } from "@/contexts/AuthContext";

const ICONS = { Bot, Phone, Rocket, Plug, Workflow, BarChart3 } as const;
type IconKey = keyof typeof ICONS;

const QuickSetup = () => {
  const { user } = useAuth();
  const completed = setupChecklist.filter((s) => s.completed).length;
  const percent = Math.round((completed / setupChecklist.length) * 100);
  const milestones = [0, 20, 40, 60, 80, 100];
  const firstName =
    ((user?.user_metadata?.full_name as string) || user?.email || "there").split(" ")[0];

  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/10 via-background to-background p-6 sm:p-8">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Welcome to EDM Nexus, {firstName} 👋
            </h1>
            <p className="mt-1 text-muted-foreground">
              Let's get you up and running in minutes.
            </p>
          </div>
          <CircularProgress percent={percent} />
        </div>

        <div className="mt-6">
          <div className="mb-2 flex justify-between text-xs text-muted-foreground">
            <span>Quick Setup Progress</span>
            <span className="font-medium text-foreground">{percent}%</span>
          </div>
          <div className="relative h-2 rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-primary transition-all"
              style={{ width: `${percent}%` }}
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {setupChecklist.map((item) => {
            const Icon = ICONS[item.icon as IconKey];
            return (
              <div
                key={item.id}
                className="group rounded-xl border border-border bg-card p-5 card-interactive"
              >
                <div className="flex items-start justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  {item.completed ? (
                    <CheckCircle2 className="h-5 w-5 text-primary" />
                  ) : (
                    <Circle className="h-5 w-5 text-muted-foreground" />
                  )}
                </div>
                <h3 className="mt-4 font-semibold text-foreground">{item.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                <div className="mt-4 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">⏱ {item.time}</span>
                  {item.completed ? (
                    <span className="rounded-full bg-success/15 px-2 py-0.5 font-medium text-success">
                      ✅ Completed
                    </span>
                  ) : (
                    <button className="font-medium text-primary hover:underline">
                      Start →
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
