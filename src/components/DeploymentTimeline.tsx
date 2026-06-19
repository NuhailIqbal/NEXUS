import { MessageSquare, Map, Paintbrush, Cog, Bot, Rocket } from "lucide-react";

const steps = [
  { day: "Day 1", title: "Platform Consultation", desc: "We understand your business needs, goals, and target market.", icon: MessageSquare },
  { day: "Days 2-3", title: "Revenue Architecture", desc: "Custom 360° plan tailored to your industry and growth objectives.", icon: Map },
  { day: "Days 4-7", title: "System Configuration", desc: "Website, logo, brand identity, and all marketing assets created.", icon: Paintbrush },
  { day: "Days 8-10", title: "Integration & Testing", desc: "Workflows, CRM, billing, analytics configured and tested.", icon: Cog },
  { day: "Days 11-13", title: "AI Deployment", desc: "Train and deploy AI agents for sales, support, and retention.", icon: Bot },
  { day: "Day 14+", title: "Revenue Generation", desc: "Go live with 24/7 operations and unlimited scaling potential.", icon: Rocket },
];

const DeploymentTimeline = () => (
  <section className="py-24">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">PLATFORM DEPLOYMENT</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          From Integration to Revenue. <span className="text-gradient">In Days, Not Months.</span>
        </h2>
      </div>

      <div className="relative max-w-4xl mx-auto">
        {/* Vertical line */}
        <div className="hidden md:block absolute left-8 top-0 bottom-0 w-px bg-gradient-to-b from-primary/50 via-primary/20 to-transparent" />

        <div className="space-y-8">
          {steps.map((step, i) => (
            <div key={step.title} className="flex gap-6 items-start group">
              <div className="hidden md:flex flex-col items-center">
                <div className="w-16 h-16 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <step.icon size={24} className="text-primary" />
                </div>
              </div>
              <div className="surface-card p-6 flex-1">
                <span className="text-xs font-bold text-primary uppercase tracking-wider">{step.day}</span>
                <h3 className="text-lg font-bold text-foreground mt-1">{step.title}</h3>
                <p className="text-sm text-muted-foreground mt-2">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Before / After */}
      <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto mt-16">
        <div className="surface-card p-6 text-center">
          <span className="text-3xl mb-3 block">💡</span>
          <h3 className="text-lg font-bold text-foreground">Your Idea</h3>
          <p className="text-sm text-muted-foreground mt-2">A vision waiting to become reality. Uncertainty about next steps.</p>
          <span className="text-xs font-bold text-muted-foreground mt-3 block">DAY 0</span>
        </div>
        <div className="glow-border rounded-xl p-6 text-center bg-card">
          <span className="text-3xl mb-3 block">🏢</span>
          <h3 className="text-lg font-bold text-foreground">Your Empire</h3>
          <p className="text-sm text-muted-foreground mt-2">Fully operational business with AI workforce and 24/7 operations.</p>
          <span className="text-xs font-bold text-primary mt-3 block">DAY 14</span>
        </div>
      </div>

      {/* Counter stats */}
      <div className="grid grid-cols-3 gap-6 max-w-xl mx-auto mt-12 text-center">
        <div>
          <div className="stat-number">14</div>
          <div className="text-xs text-muted-foreground mt-1">Days to Launch</div>
        </div>
        <div>
          <div className="stat-number">500+</div>
          <div className="text-xs text-muted-foreground mt-1">Businesses Built</div>
        </div>
        <div>
          <div className="stat-number">97%</div>
          <div className="text-xs text-muted-foreground mt-1">Success Rate</div>
        </div>
      </div>
    </div>
  </section>
);

export default DeploymentTimeline;
