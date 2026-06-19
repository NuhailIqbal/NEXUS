import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Brain, Route, BarChart3, Shield, Globe, Zap, Radio, Cpu, Network, Layers, Target, Gauge } from "lucide-react";

const features = [
  {
    icon: Brain,
    title: "Neural Call Routing",
    description: "AI-powered routing engine that analyzes caller intent, geographic signals, and historical patterns to match calls with the highest-converting buyers in real time.",
    highlight: "98.7% match accuracy",
  },
  {
    icon: Route,
    title: "Dynamic Lead Distribution",
    description: "Intelligent distribution system that balances lead flow across buyer networks using predictive scoring models and real-time capacity management.",
    highlight: "< 200ms routing",
  },
  {
    icon: BarChart3,
    title: "Revenue Optimization Engine",
    description: "Machine learning models that continuously optimize bid prices, payout structures, and buyer selection to maximize revenue per interaction.",
    highlight: "+340% avg ROI",
  },
  {
    icon: Shield,
    title: "Fraud Detection & Prevention",
    description: "Multi-layer fraud analysis using behavioral biometrics, device fingerprinting, and anomaly detection to protect your revenue pipeline.",
    highlight: "99.9% fraud catch rate",
  },
  {
    icon: Globe,
    title: "Multi-Language AI Agents",
    description: "Deploy autonomous conversational AI agents that speak 29+ languages natively, handling qualification, scheduling, and transfers 24/7.",
    highlight: "29+ languages",
  },
  {
    icon: Zap,
    title: "Real-Time Analytics Dashboard",
    description: "Live operational intelligence with custom KPI tracking, automated alerts, and predictive forecasting across all campaigns.",
    highlight: "Live monitoring",
  },
  {
    icon: Radio,
    title: "Omnichannel Integration",
    description: "Unified platform connecting inbound calls, SMS, chat, and digital leads through a single intelligent routing infrastructure.",
    highlight: "4 channels",
  },
  {
    icon: Cpu,
    title: "Predictive Buyer Matching",
    description: "Deep learning algorithms that predict buyer intent and conversion probability, ensuring every lead reaches its optimal destination.",
    highlight: "ML-powered",
  },
  {
    icon: Network,
    title: "API-First Architecture",
    description: "RESTful and webhook APIs for seamless integration with your existing tech stack — CRMs, dialers, analytics platforms, and more.",
    highlight: "100+ integrations",
  },
  {
    icon: Layers,
    title: "Campaign Management Suite",
    description: "End-to-end campaign orchestration with A/B testing, budget optimization, creative management, and automated performance reporting.",
    highlight: "Full automation",
  },
  {
    icon: Target,
    title: "Geo-Targeting & Compliance",
    description: "Precision geographic targeting with built-in TCPA, GDPR, and state-level regulatory compliance enforcement.",
    highlight: "Auto-compliant",
  },
  {
    icon: Gauge,
    title: "Performance Benchmarking",
    description: "Industry benchmarking tools that compare your performance metrics against anonymized network-wide data to identify growth opportunities.",
    highlight: "Network insights",
  },
];

const Features = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            PLATFORM CAPABILITIES
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Built for <span className="text-gradient">Intelligence</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Every feature is powered by machine learning, designed for scale, and optimized for revenue.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="surface-card p-6 animate-slide-up group"
              style={{ animationDelay: `${0.05 * i}s` }}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <f.icon size={22} className="text-primary" />
                </div>
                <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-1 rounded-md">
                  {f.highlight}
                </span>
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Features;
