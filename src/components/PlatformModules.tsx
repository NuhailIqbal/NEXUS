import { Target, Palette, Settings, Bot, MessageSquare, Building2 } from "lucide-react";

const modules = [
  {
    icon: Target,
    tag: "High-Intent Leads",
    title: "Acquisition Engine",
    description: "Proprietary algorithms surface high-intent prospects across 6+ verticals.",
    features: ["150+ Active Campaigns", "20,000+ Calls/Day", "$500K+ Weekly Payouts", "Form Fills & Live Transfers"],
    stat: "95%",
    statLabel: "Intent Match Rate",
  },
  {
    icon: Palette,
    tag: "Professional Identity",
    title: "Brand Studio",
    description: "Enterprise-grade brand identity and conversion-optimized digital presence.",
    features: ["Custom Website Design", "Brand Identity Package", "Marketing Assets", "SEO Optimization"],
    stat: "48hr",
    statLabel: "Turnaround Time",
  },
  {
    icon: Settings,
    tag: "Streamlined Operations",
    title: "Operations OS",
    description: "Automated workflows, CRM, billing, and analytics in one control center.",
    features: ["Workflow Automation", "Real-Time Analytics", "CRM Integration", "Automated Billing"],
    stat: "80%",
    statLabel: "Time Saved",
  },
  {
    icon: Bot,
    tag: "Intelligent Agents",
    title: "AI Workforce Cloud",
    description: "Deploy AI agents for sales, support, and retention at infinite scale.",
    features: ["Sales AI Agents", "Customer Service AI", "Retention & Collections", "Admin & Scheduling AI"],
    stat: "∞",
    statLabel: "Scalability",
  },
  {
    icon: MessageSquare,
    tag: "Always Connected",
    title: "Omni-Channel Hub",
    description: "Unified voice, SMS, email, chat, and WhatsApp across 29+ languages.",
    features: ["Voice & SMS", "Live Chat & WhatsApp", "24/7/365 Availability", "29+ Languages"],
    stat: "24/7",
    statLabel: "Availability",
  },
  {
    icon: Building2,
    tag: "Your Brand, Our Power",
    title: "White-Label Platform",
    description: "Fully branded infrastructure with API access and revenue-share models.",
    features: ["Fully Branded Platform", "Unlimited Users", "Revenue Share Model", "Enterprise Security"],
    stat: "100%",
    statLabel: "Your Brand",
  },
];

const PlatformModules = () => (
  <section id="features" className="py-24 relative">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">THE PLATFORM</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          One Infrastructure. <span className="text-gradient">Unlimited Revenue.</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          Six integrated modules that power, scale, and monetize your inbound acquisition pipeline.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {modules.map((mod) => (
          <div key={mod.title} className="surface-card p-6 flex flex-col gap-4 group">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <mod.icon size={20} className="text-primary" />
              </div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{mod.tag}</span>
            </div>

            <h3 className="text-xl font-bold text-foreground">{mod.title}</h3>
            <p className="text-sm text-muted-foreground">{mod.description}</p>

            <div className="flex flex-wrap gap-2 mt-auto">
              {mod.features.map((f) => (
                <span key={f} className="text-xs px-2.5 py-1 rounded-md bg-secondary text-secondary-foreground">{f}</span>
              ))}
            </div>

            <div className="pt-4 border-t border-border flex items-baseline gap-2">
              <span className="text-3xl font-black text-gradient">{mod.stat}</span>
              <span className="text-sm text-muted-foreground">{mod.statLabel}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default PlatformModules;
