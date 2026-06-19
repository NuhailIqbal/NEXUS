import { Target, Route, Phone, BarChart3, Zap, TrendingUp } from "lucide-react";

const stats = [
  { icon: Target, title: "Acquisition Intelligence", desc: "Matching algorithms that surface the highest-intent prospects", stat: "95%", statLabel: "intent match rate" },
  { icon: Route, title: "Lead Distribution Engine", desc: "Automated routing to the right buyer in real time", stat: "45%", statLabel: "conversion lift" },
  { icon: Phone, title: "Real-Time Call Routing", desc: "Verified inbound calls matched and delivered instantly", stat: "100%", statLabel: "verified calls" },
  { icon: BarChart3, title: "Revenue Optimization", desc: "AI-driven pricing and bid optimization across every campaign", stat: "5X", statLabel: "return on spend" },
  { icon: Zap, title: "Instant API Delivery", desc: "Sub-30-second lead delivery via API or direct integration", stat: "<30s", statLabel: "delivery time" },
  { icon: TrendingUp, title: "Elastic Infrastructure", desc: "Scale from 10 to 10,000 concurrent operations on demand", stat: "∞", statLabel: "growth potential" },
];

const PerformanceStats = () => (
  <section className="py-24">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-5xl font-bold">
          Platform Performance <span className="text-gradient">at Scale</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          Proprietary infrastructure powering millions of optimized inbound interactions.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {stats.map((s) => (
          <div key={s.title} className="surface-card p-6 flex flex-col gap-3">
            <s.icon size={20} className="text-primary" />
            <h3 className="text-lg font-bold text-foreground">{s.title}</h3>
            <p className="text-sm text-muted-foreground">{s.desc}</p>
            <div className="mt-auto pt-3 border-t border-border">
              <span className="text-2xl font-black text-gradient">{s.stat}</span>
              <span className="text-sm text-muted-foreground ml-2">{s.statLabel}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default PerformanceStats;
