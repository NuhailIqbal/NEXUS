import { Check, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

// Comparisons are deliberately structural — differences that follow from software vs.
// staffing — rather than performance percentages we can't substantiate.
const comparisons = [
  {
    label: "Availability",
    trad: "Business hours",
    edm: "Any hour",
    desc: "An agent picks up at 2am and on weekends without a night shift.",
  },
  {
    label: "Time to ramp up",
    trad: "Recruit & train",
    edm: "Configure & test",
    desc: "Set the goal, voice and knowledge, then test it in the same sitting.",
  },
  {
    label: "Cost when idle",
    trad: "Paid regardless",
    edm: "Nothing",
    desc: "You're billed per connected minute, so quiet days cost you nothing.",
  },
];

// Each row is true by how the platform works, not a competitive claim.
const features = [
  "Answers outside business hours",
  "Follows the same script every call",
  "Records and transcribes every call",
  "Handles several calls at once",
  "Costs nothing while idle",
];

const Comparison = () => (
  <section id="advertisers" className="py-24">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">Why AI agents</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          How it compares to <span className="text-gradient">an in-house calling team</span>
        </h2>
      </div>

      {/* Structural comparisons */}
      <div className="grid md:grid-cols-3 gap-6 mb-16 max-w-4xl mx-auto">
        {comparisons.map((c) => (
          <div key={c.label} className="surface-card p-6 text-center">
            <h3 className="text-sm font-bold text-muted-foreground uppercase tracking-wider mb-4">{c.label}</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2 rounded-lg bg-secondary/60">
                <span className="text-xs text-muted-foreground">In-house team</span>
                <span className="text-sm font-bold text-foreground">{c.trad}</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded-lg bg-primary/10">
                <span className="text-xs text-muted-foreground">EDM Nexus</span>
                <span className="text-sm font-bold text-primary">{c.edm}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-3">{c.desc}</p>
          </div>
        ))}
      </div>

      {/* Feature table */}
      <div className="surface-card p-6 max-w-2xl mx-auto">
        <h3 className="text-lg font-bold text-foreground mb-6 text-center">What an AI agent does differently</h3>
        <div className="space-y-3">
          <div className="grid grid-cols-3 text-xs font-bold text-muted-foreground uppercase tracking-wider pb-3 border-b border-border">
            <span>Capability</span>
            <span className="text-center">In-house team</span>
            <span className="text-center">EDM Nexus</span>
          </div>
          {features.map((f) => (
            <div key={f} className="grid grid-cols-3 items-center py-2">
              <span className="text-sm text-foreground">{f}</span>
              <span className="flex justify-center"><X size={16} className="text-muted-foreground/60" /></span>
              <span className="flex justify-center"><Check size={16} className="text-primary" /></span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground text-center mt-4">
          AI agents aren't a replacement for a good sales team. They cover the calls that would
          otherwise go unanswered, and hand the promising ones straight over to a person.
        </p>
      </div>

      <div className="text-center mt-10">
        <Link to="/register">
          <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8">
            Try it with $20 free credit
          </Button>
        </Link>
      </div>
    </div>
  </section>
);

export default Comparison;
