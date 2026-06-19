import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Check, ArrowRight, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";

const plans = [
  {
    name: "Starter",
    price: "Custom",
    description: "For emerging publishers and advertisers getting started with performance marketing.",
    features: [
      "Up to 5,000 calls/month",
      "Basic AI call routing",
      "Standard analytics dashboard",
      "Email support",
      "5 campaign slots",
      "API access",
    ],
    cta: "Get Started",
    highlighted: false,
  },
  {
    name: "Growth",
    price: "Custom",
    description: "For scaling teams that need advanced AI optimization and premium buyer access.",
    features: [
      "Up to 50,000 calls/month",
      "Neural routing engine",
      "Advanced analytics & reporting",
      "Priority support + Slack channel",
      "Unlimited campaigns",
      "Full API + webhook access",
      "AI agent deployment (5 agents)",
      "Fraud detection suite",
      "Custom integrations",
    ],
    cta: "Request Access",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    description: "For organizations requiring unlimited scale, dedicated infrastructure, and SLA guarantees.",
    features: [
      "Unlimited calls",
      "Dedicated neural routing cluster",
      "White-label platform option",
      "24/7 dedicated account team",
      "Unlimited everything",
      "Custom ML model training",
      "Unlimited AI agents (29+ languages)",
      "Advanced fraud & compliance",
      "Custom SLA & uptime guarantees",
      "On-premise deployment option",
    ],
    cta: "Contact Sales",
    highlighted: false,
  },
];

const Pricing = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            PRICING
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Built to <span className="text-gradient">Scale With You</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Performance-based pricing aligned with your revenue goals. No upfront fees, no hidden costs.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          {plans.map((plan, i) => (
            <div
              key={plan.name}
              className={`rounded-2xl p-6 animate-slide-up flex flex-col ${
                plan.highlighted
                  ? "glow-border bg-card relative"
                  : "surface-card"
              }`}
              style={{ animationDelay: `${0.1 * i}s` }}
            >
              {plan.highlighted && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-primary text-primary-foreground">
                    <Sparkles size={12} /> MOST POPULAR
                  </span>
                </div>
              )}
              <div className="mb-6">
                <h3 className="text-xl font-bold text-foreground mb-1">{plan.name}</h3>
                <div className="text-3xl font-black text-gradient mb-2">{plan.price}</div>
                <p className="text-sm text-muted-foreground">{plan.description}</p>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <Check size={16} className="text-primary mt-0.5 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link to="/request-access">
                <Button
                  className={`w-full gap-2 ${
                    plan.highlighted
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                  }`}
                >
                  {plan.cta} <ArrowRight size={16} />
                </Button>
              </Link>
            </div>
          ))}
        </div>

        <div className="text-center mt-12 animate-slide-up" style={{ animationDelay: "0.4s" }}>
          <p className="text-sm text-muted-foreground">
            All plans include SOC 2 compliance, 99.99% uptime SLA, and dedicated onboarding. 
            <Link to="/request-access" className="text-primary hover:underline ml-1">Contact us</Link> for volume pricing.
          </p>
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Pricing;
