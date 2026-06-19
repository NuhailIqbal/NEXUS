import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Brain, Cpu, Database, Cloud, Lock, Zap, GitBranch, Server, Activity } from "lucide-react";

const techStack = [
  { icon: Brain, label: "Neural Networks", desc: "Deep learning models trained on billions of call interactions for routing optimization" },
  { icon: Cpu, label: "Edge Computing", desc: "Sub-200ms latency through globally distributed edge inference nodes" },
  { icon: Database, label: "Real-Time Data Pipeline", desc: "Stream processing engine handling 10M+ events per second" },
  { icon: Cloud, label: "Cloud-Native Infrastructure", desc: "Auto-scaling Kubernetes clusters across 12 global regions" },
  { icon: Lock, label: "Zero-Trust Security", desc: "End-to-end encryption, SOC 2 Type II certified, HIPAA compliant" },
  { icon: Zap, label: "AutoML Pipeline", desc: "Self-improving models that retrain on live performance data every 6 hours" },
];

const metrics = [
  { value: "< 200ms", label: "Avg Routing Latency" },
  { value: "99.99%", label: "Uptime SLA" },
  { value: "10M+", label: "Events/Second" },
  { value: "12", label: "Global Regions" },
  { value: "2B+", label: "Calls Processed" },
  { value: "6hr", label: "Model Retrain Cycle" },
];

const Technology = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] rounded-full bg-accent/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            ENGINEERING
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            The AI <span className="text-gradient">Architecture</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Purpose-built infrastructure turning raw signal into revenue at machine speed.
          </p>
        </div>

        {/* Architecture Visual */}
        <div className="glow-border rounded-2xl p-8 mb-16 animate-slide-up" style={{ animationDelay: "0.3s" }}>
          <div className="grid md:grid-cols-3 gap-8">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                <Activity size={28} className="text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Signal Ingestion</h3>
              <p className="text-sm text-muted-foreground">Multi-channel data intake from calls, clicks, forms, and IoT signals processed through unified stream architecture.</p>
            </div>
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-accent/10 border border-accent/20 flex items-center justify-center mx-auto mb-4">
                <GitBranch size={28} className="text-accent" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Neural Processing</h3>
              <p className="text-sm text-muted-foreground">Transformer-based models score, classify, and route each interaction through proprietary decision graphs.</p>
            </div>
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                <Server size={28} className="text-primary" />
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">Execution Layer</h3>
              <p className="text-sm text-muted-foreground">Real-time bid optimization, dynamic routing, and automated campaign management with full observability.</p>
            </div>
          </div>
        </div>

        {/* Tech Stack */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {techStack.map((t, i) => (
            <div key={t.label} className="surface-card p-6 animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                <t.icon size={20} className="text-primary" />
              </div>
              <h3 className="font-bold text-foreground mb-1">{t.label}</h3>
              <p className="text-sm text-muted-foreground">{t.desc}</p>
            </div>
          ))}
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {metrics.map((m, i) => (
            <div key={m.label} className="text-center p-4 rounded-xl border border-border bg-card animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="text-2xl font-black text-gradient mb-1">{m.value}</div>
              <div className="text-xs text-muted-foreground">{m.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Technology;
