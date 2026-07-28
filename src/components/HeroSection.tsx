import { ArrowRight, PhoneIncoming, PhoneOutgoing, FileAudio, Users, Gauge, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

// Real jobs an agent on this platform is configured to do (see the agent wizard).
const rotatingWords = [
  "Outbound Campaigns",
  "Inbound Reception",
  "Lead Qualification",
  "Appointment Booking",
  "Follow-Up Calls",
];

// Every badge below maps to a shipped feature in the dashboard.
const badges = [
  { icon: PhoneOutgoing, label: "Outbound Campaigns" },
  { icon: PhoneIncoming, label: "AI Receptionist" },
  { icon: FileAudio, label: "Recordings & Transcripts" },
  { icon: Repeat, label: "Live Call Transfer" },
  { icon: Users, label: "Contacts & Lists" },
  { icon: Gauge, label: "Per-Minute Billing" },
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
          AI VOICE AGENTS FOR SALES &amp; SUPPORT
        </div>

        <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black tracking-tight mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
          AI AGENTS THAT
          <br />
          <span className="text-gradient">WORK THE PHONES</span>
        </h1>

        <div className="text-xl md:text-2xl font-medium mb-6 animate-slide-up" style={{ animationDelay: "0.2s" }}>
          Built for{" "}
          <span className="text-gradient font-bold" key={wordIndex}>
            {rotatingWords[wordIndex]}
          </span>
        </div>

        <p className="max-w-2xl mx-auto text-muted-foreground text-base md:text-lg mb-10 animate-slide-up" style={{ animationDelay: "0.3s" }}>
          Build a voice agent, give it a phone number, and it starts{" "}
          <strong className="text-foreground">making and answering real calls</strong>. Every call is
          recorded and transcribed, and qualified callers can be transferred straight to your team.{" "}
          <strong className="text-foreground">Around $0.35 a minute, with no subscription.</strong>
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
          <Link to="/register">
            <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2 text-base">
              Start with $20 free credit <ArrowRight size={18} />
            </Button>
          </Link>
        </div>

        <p className="mt-5 text-xs text-muted-foreground animate-slide-up" style={{ animationDelay: "0.6s" }}>
          No card required to sign up · Pay only for the minutes you use
        </p>
      </div>

      <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
    </section>
  );
};

export default HeroSection;
