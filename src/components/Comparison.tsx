import { Check, X, Clock, TrendingUp, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const comparisons = [
  { label: "Response Time", trad: "24+ hours", edm: "8 seconds", desc: "Immediate response to leads 24/7" },
  { label: "Conversion Rate", trad: "18%", edm: "42.7%", desc: "Perfect script execution every time" },
  { label: "Scalability", trad: "Weeks to hire", edm: "Instant scaling", desc: "Deploy thousands of agents in seconds" },
];

const features = [
  "24/7 Availability",
  "Instant Scaling",
  "Consistent Quality",
  "No Human Fatigue",
  "Unlimited Concurrent Calls",
];

const Comparison = () => (
  <section id="advertisers" className="py-24">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">By The Numbers</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          AI vs. <span className="text-gradient">Traditional Telemarketing</span>
        </h2>
      </div>

      {/* Metric comparisons */}
      <div className="grid md:grid-cols-3 gap-6 mb-16 max-w-4xl mx-auto">
        {comparisons.map((c) => (
          <div key={c.label} className="surface-card p-6 text-center">
            <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-4">{c.label}</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2 rounded-lg bg-destructive/10">
                <span className="text-xs text-muted-foreground">Traditional</span>
                <span className="text-sm font-bold text-destructive">{c.trad}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-primary/10">
                <span className="text-xs text-muted-foreground">Nexus AI</span>
                <span className="text-sm font-bold text-primary">{c.edm}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">{c.desc}</p>
          </div>
        ))}
      </div>

      {/* Feature table */}
      <div className="surface-card p-6 max-w-2xl mx-auto">
        <h3 className="text-lg font-bold text-foreground mb-6 text-center">Nexus Platform vs. Legacy Solutions</h3>
        <div className="space-y-3">
          <div className="grid grid-cols-3 text-xs font-bold text-muted-foreground uppercase tracking-wider pb-3 border-b border-border">
            <span>Feature</span>
            <span className="text-center">Traditional</span>
            <span className="text-center">Nexus</span>
          </div>
          {features.map((f) => (
            <div key={f} className="grid grid-cols-3 items-center py-2">
              <span className="text-sm text-foreground">{f}</span>
              <span className="flex justify-center"><X size={16} className="text-destructive/60" /></span>
              <span className="flex justify-center"><Check size={16} className="text-primary" /></span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground text-center mt-4">
          EDM Nexus outperforms traditional telemarketing in every category.
        </p>
      </div>

      <div className="text-center mt-10">
        <Link to="/request-access">
          <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8">
            See the Platform in Action
          </Button>
        </Link>
      </div>
    </div>
  </section>
);

export default Comparison;
