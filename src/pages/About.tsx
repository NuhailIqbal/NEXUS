import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { ArrowRight, Headset, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { Link } from "react-router-dom";

const values = [
  {
    icon: Headset,
    title: "Built for real calls",
    desc: "Every feature exists because a call needed to be answered, transferred, or followed up on — not because it looked good on a roadmap.",
  },
  {
    icon: Sparkles,
    title: "No black boxes",
    desc: "Every call you make or answer comes back with the recording, the transcript, and the summary attached. You should never have to wonder what happened on a call.",
  },
  {
    icon: Wallet,
    title: "Pay for what you use",
    desc: "No seat licenses, no tiered plans, no annual contracts. You top up a balance and calls draw down from it, minute by minute.",
  },
  {
    icon: ShieldCheck,
    title: "You stay in control",
    desc: "You decide who your agents call, what they say, and when they hand off to a person. We give you the tools; the judgment calls stay with you.",
  },
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
            An AI agent for <span className="text-gradient">your phone</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            EDM Nexus lets any business build an AI voice agent, put it on a real phone number,
            and have it make or answer calls — with every call recorded, transcribed, and billed
            by the minute.
          </p>
        </div>

        {/* Mission */}
        <div className="glow-border rounded-2xl p-8 md:p-12 mb-16 text-center animate-slide-up" style={{ animationDelay: "0.3s" }}>
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">Why we built this</h2>
          <p className="text-muted-foreground text-lg max-w-3xl mx-auto leading-relaxed">
            Most calls that matter to a small or mid-size business — the after-hours enquiry, the
            appointment reminder, the lead that went cold — never get made because there's no one
            free to make them. We built EDM Nexus so a team can put an AI agent on the phone in
            minutes, without hiring, scripting a call center, or signing a contract.
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

        <div className="text-center animate-slide-up" style={{ animationDelay: "0.4s" }}>
          <Link to="/register">
            <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2">
              Start with $20 free credit <ArrowRight size={18} />
            </Button>
          </Link>
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default About;
