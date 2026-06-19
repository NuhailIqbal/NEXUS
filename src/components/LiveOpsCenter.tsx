import { Activity, Users, Phone, Languages, MessageSquare, Zap, CheckCircle, Shield, Star } from "lucide-react";

const metrics = [
  { icon: Users, value: "1,247", label: "Active AI Agents", sub: "Operating globally right now" },
  { icon: Phone, value: "18,436", label: "Calls Handled Today", sub: "Across all time zones" },
  { icon: Languages, value: "12", label: "Languages Active", sub: "Real-time translations" },
  { icon: MessageSquare, value: "142,866", label: "Messages Processed", sub: "Chat, email, and SMS" },
  { icon: Zap, value: "374ms", label: "Avg Response Time", sub: "Lightning-fast replies" },
  { icon: CheckCircle, value: "45,233", label: "Tasks Completed", sub: "Automated workflows today" },
  { icon: Star, value: "98.4%", label: "Satisfaction Rate", sub: "Customer happiness score" },
  { icon: Shield, value: "100.0%", label: "System Uptime", sub: "24/7/365 reliability" },
];

const activityFeed = [
  { flag: "🇳🇴", text: "Support ticket resolved in Norwegian", detail: "Issue #11551" },
  { flag: "🇮🇱", text: "Invoice sent in Hebrew", detail: "€1,850.00" },
  { flag: "🇷🇴", text: "Appointment scheduled in Romanian", detail: "Tomorrow 10:00 AM" },
  { flag: "🇫🇮", text: "Customer onboarded in Finnish", detail: "Premium Plan" },
];

const LiveOpsCenter = () => (
  <section className="py-24 relative overflow-hidden">
    <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.02] via-transparent to-transparent pointer-events-none" />
    <div className="container mx-auto px-4 relative z-10">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">Live Operations Center</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          Real-Time <span className="text-gradient">Business Intelligence</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          Watch your AI workforce in action. Every metric updates live.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {metrics.map((m) => (
          <div key={m.label} className="surface-card p-5">
            <m.icon size={18} className="text-primary mb-3" />
            <div className="text-2xl font-black text-foreground">{m.value}</div>
            <div className="text-sm font-semibold text-foreground mt-1">{m.label}</div>
            <div className="text-xs text-muted-foreground">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* Activity feed */}
      <div className="surface-card p-6 max-w-2xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <Activity size={16} className="text-primary animate-pulse" />
          <h3 className="text-sm font-bold text-foreground">Live Activity Feed</h3>
        </div>
        <div className="space-y-3">
          {activityFeed.map((item, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50">
              <span className="text-xl">{item.flag}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground">{item.text}</div>
              </div>
              <span className="text-xs text-primary font-medium">{item.detail}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 mt-4 pt-4 border-t border-border text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-primary animate-pulse" /> All systems operational</span>
          <span>Serving 47 countries</span>
        </div>
      </div>
    </div>
  </section>
);

export default LiveOpsCenter;
