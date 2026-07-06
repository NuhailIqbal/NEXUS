import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { ArrowRight, TrendingUp, Target, Shield, BarChart3, Clock, DollarSign } from "lucide-react";
import { Link } from "react-router-dom";

const benefits = [
  { icon: TrendingUp, title: "Higher Conversion Rates", desc: "AI matched leads convert 3.4x better than traditional distribution. Our neural routing finds the right buyer for every call." },
  { icon: Target, title: "Precision Targeting", desc: "Define your ideal customer profile and our ML models will filter, score, and route only qualified prospects to your team." },
  { icon: Shield, title: "Fraud Protection", desc: "Multi-layer fraud detection eliminates bot traffic, spoofed calls, and low-intent interactions before they reach you." },
  { icon: BarChart3, title: "Real-Time Reporting", desc: "Live dashboards with conversion tracking, revenue attribution, and AI powered recommendations for campaign optimization." },
  { icon: Clock, title: "24/7 AI Qualification", desc: "Autonomous agents pre-qualify callers in 29+ languages, collecting intent data before transferring to your sales team." },
  { icon: DollarSign, title: "Pay-Per-Result", desc: "Performance-based pricing means you only pay for qualified, converted interactions. Zero waste, maximum ROI." },
];

const stats = [
  { value: "$2.4B+", label: "Revenue Generated for Advertisers" },
  { value: "3.4x", label: "Avg Conversion Lift" },
  { value: "340%", label: "Average ROAS" },
  { value: "< 30s", label: "Avg Connect Time" },
];

const Advertisers = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/3 left-1/4 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            FOR ADVERTISERS
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Scale Revenue with <span className="text-gradient">AI Precision</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Stop buying leads. Start buying results. Our AI infrastructure delivers pre-qualified, 
            high-intent interactions direct to your sales pipeline.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16">
          {stats.map((s, i) => (
            <div key={s.label} className="glow-border rounded-xl p-6 text-center animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="text-3xl font-black text-gradient mb-1">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Benefits */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {benefits.map((b, i) => (
            <div key={b.title} className="surface-card p-6 animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                <b.icon size={22} className="text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">{b.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{b.desc}</p>
            </div>
          ))}
        </div>

        <div className="text-center animate-slide-up" style={{ animationDelay: "0.4s" }}>
          <Link to="/request-access">
            <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2">
              Start Generating Revenue <ArrowRight size={18} />
            </Button>
          </Link>
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Advertisers;
