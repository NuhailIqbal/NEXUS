import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { ArrowRight, Megaphone, Globe, Wallet, LineChart, Layers, Plug } from "lucide-react";
import { Link } from "react-router-dom";

const benefits = [
  { icon: Wallet, title: "Maximize Payouts", desc: "Our AI auction system pits hundreds of buyers against each other in real-time, ensuring you get the highest possible payout per call." },
  { icon: Megaphone, title: "Premium Demand Access", desc: "Connect to 500+ verified advertisers across insurance, legal, home services, financial services, and healthcare verticals." },
  { icon: Globe, title: "Multi-Channel Monetization", desc: "Monetize calls, clicks, forms, and chat interactions through a single unified platform with centralized reporting." },
  { icon: LineChart, title: "Transparent Analytics", desc: "Real-time visibility into call durations, conversion rates, revenue per call, and buyer performance with zero data lag." },
  { icon: Layers, title: "Creative & Landing Pages", desc: "AI-generated, compliance-tested creative assets and landing pages optimized for your traffic sources and verticals." },
  { icon: Plug, title: "Easy Integration", desc: "Drop-in tracking pixels, API endpoints, and webhook integrations. Go live in under 24 hours with dedicated onboarding support." },
];

const stats = [
  { value: "500+", label: "Active Buyers" },
  { value: "$48", label: "Avg Revenue/Call" },
  { value: "15+", label: "Verticals" },
  { value: "Net-7", label: "Payment Terms" },
];

const Publishers = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-[500px] h-[500px] rounded-full bg-accent/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            FOR PUBLISHERS
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Monetize Traffic with <span className="text-gradient">AI Power</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Turn your traffic into premium revenue. Our AI matches your leads with the highest-bidding buyers 
            in real time across 15+ verticals.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-16">
          {stats.map((s, i) => (
            <div key={s.label} className="glow-border rounded-xl p-6 text-center animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="text-3xl font-black text-gradient mb-1">{s.value}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

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
              Start Earning More <ArrowRight size={18} />
            </Button>
          </Link>
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Publishers;
