import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { ArrowRight, MapPin, Users, Zap, Award } from "lucide-react";
import { Link } from "react-router-dom";

const values = [
  { icon: Zap, title: "Innovation First", desc: "We push the boundaries of what AI can do in performance marketing. Every feature starts with a research question." },
  { icon: Users, title: "Partner Success", desc: "Our partners' growth is our growth. We invest deeply in relationships, providing dedicated support and strategic guidance." },
  { icon: Award, title: "Relentless Quality", desc: "From 99.99% uptime to sub-200ms routing, we obsess over every millisecond and every data point." },
  { icon: MapPin, title: "Global Scale", desc: "Operating across 12 regions with AI agents speaking 29+ languages, we connect the world's buyers and sellers." },
];

const milestones = [
  { year: "2019", event: "Founded with a vision to bring AI to performance marketing" },
  { year: "2020", event: "Launched neural call routing engine, processing 100K calls/month" },
  { year: "2021", event: "Reached $100M in platform revenue, expanded to 15+ verticals" },
  { year: "2022", event: "Deployed multilingual AI agents covering 29+ languages globally" },
  { year: "2023", event: "Processed 2 billionth call, launched predictive buyer matching" },
  { year: "2024", event: "Introduced autonomous campaign optimization and self-improving ML models" },
];

const About = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            ABOUT EDM NEXUS
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            The Future of <span className="text-gradient">Revenue Infrastructure</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            EDM Nexus is the AI-powered performance marketing platform that connects advertisers 
            with publishers through intelligent, real-time revenue optimization.
          </p>
        </div>

        {/* Mission */}
        <div className="glow-border rounded-2xl p-8 md:p-12 mb-16 text-center animate-slide-up" style={{ animationDelay: "0.3s" }}>
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">Our Mission</h2>
          <p className="text-muted-foreground text-lg max-w-3xl mx-auto leading-relaxed">
            To build the world's most intelligent revenue infrastructure — where every inbound interaction 
            is matched, qualified, and monetized by AI, creating unprecedented value for advertisers, 
            publishers, and the consumers they serve.
          </p>
        </div>

        {/* Values */}
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
          {values.map((v, i) => (
            <div key={v.title} className="surface-card p-6 text-center animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                <v.icon size={22} className="text-primary" />
              </div>
              <h3 className="font-bold text-foreground mb-2">{v.title}</h3>
              <p className="text-sm text-muted-foreground">{v.desc}</p>
            </div>
          ))}
        </div>

        {/* Timeline */}
        <div className="max-w-2xl mx-auto mb-16">
          <h2 className="text-2xl font-bold text-foreground text-center mb-8 animate-slide-up">Our Journey</h2>
          <div className="space-y-4">
            {milestones.map((m, i) => (
              <div key={m.year} className="flex gap-4 items-start animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
                <div className="w-16 shrink-0 text-right">
                  <span className="font-mono font-bold text-primary">{m.year}</span>
                </div>
                <div className="w-px bg-primary/30 shrink-0 self-stretch" />
                <p className="text-sm text-muted-foreground pb-4">{m.event}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="text-center animate-slide-up" style={{ animationDelay: "0.4s" }}>
          <Link to="/request-access">
            <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2">
              Join Our Network <ArrowRight size={18} />
            </Button>
          </Link>
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default About;
