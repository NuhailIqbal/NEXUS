import { ArrowRight, Phone, Brain, Cpu, Network, Zap, Radio, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

const rotatingWords = [
  "Revenue Optimization",
  "Neural Call Routing",
  "Predictive Matching",
  "Real-Time Intelligence",
  "Autonomous Scale",
];

const badges = [
  { icon: Brain, label: "Neural Engine" },
  { icon: Network, label: "Smart Routing" },
  { icon: Cpu, label: "ML Pipeline" },
  { icon: Radio, label: "Live Signal" },
  { icon: Zap, label: "Auto Optimization" },
  { icon: Layers, label: "Multi-Channel" },
];

const HeroSection = () => {
  const [wordIndex, setWordIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setWordIndex((prev) => (prev + 1) % rotatingWords.length);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center pt-16 overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 grid-pattern opacity-30 pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] rounded-full bg-accent/5 blur-[120px] pointer-events-none" />

      {/* Orbiting elements */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[300px] h-[300px] pointer-events-none opacity-20">
        <div className="animate-orbit absolute top-1/2 left-1/2 w-3 h-3 rounded-full bg-primary" />
      </div>

      <div className="container mx-auto px-4 text-center relative z-10">
        <div className="badge-pill mx-auto mb-8 animate-slide-up">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
          AI POWERED REVENUE INFRASTRUCTURE
        </div>

        <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black tracking-tight mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
          THE NEURAL
          <br />
          <span className="text-gradient">REVENUE ENGINE</span>
        </h1>

        <div className="text-xl md:text-2xl font-medium mb-6 animate-slide-up" style={{ animationDelay: "0.2s" }}>
          Powering{" "}
          <span className="text-gradient font-bold" key={wordIndex}>
            {rotatingWords[wordIndex]}
          </span>{" "}
          at Scale
        </div>

        <p className="max-w-2xl mx-auto text-muted-foreground text-base md:text-lg mb-10 animate-slide-up" style={{ animationDelay: "0.3s" }}>
          EDM Nexus deploys <strong className="text-foreground">autonomous AI agents</strong> for real-time call routing, 
          predictive buyer matching, and revenue optimization across millions of inbound interactions 
          <strong className="text-foreground"> 24/7 in 29+ languages</strong>.
        </p>

        <div className="flex flex-wrap justify-center gap-3 mb-10 animate-slide-up" style={{ animationDelay: "0.4s" }}>
          {badges.map(({ icon: Icon, label }) => (
            <span key={label} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-secondary text-secondary-foreground border border-border">
              <Icon size={14} className="text-primary" />
              {label}
            </span>
          ))}
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-slide-up" style={{ animationDelay: "0.5s" }}>
          <Link to="/request-access">
            <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2 text-base">
              Request Platform Access <ArrowRight size={18} />
            </Button>
          </Link>
          <a href="tel:+18337118975">
            <Button size="lg" variant="outline" className="gap-2 border-border text-foreground hover:bg-secondary px-8 text-base">
              <Phone size={18} /> (833) 711-8975
            </Button>
          </a>
        </div>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </section>
  );
};

export default HeroSection;
