import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { ArrowRight, PhoneIncoming, MoonStar, PhoneForwarded, FileAudio, Gauge, Layers } from "lucide-react";
import { Link } from "react-router-dom";

const benefits = [
  { icon: PhoneIncoming, title: "Never miss an inbound call", desc: "Every call to your number gets answered instantly, whether it's your first call of the day or your fiftieth at once." },
  { icon: MoonStar, title: "Cover the hours you can't", desc: "Evenings, weekends, and holidays are covered without a night shift. The agent answers exactly like it would during business hours." },
  { icon: PhoneForwarded, title: "Hand off the calls that matter", desc: "The agent qualifies the caller and transfers to your team the moment a call needs a real person." },
  { icon: FileAudio, title: "A record of every conversation", desc: "Recordings, transcripts, and summaries land in your dashboard automatically, so nothing said on a call gets lost." },
  { icon: Gauge, title: "Only pay for connected minutes", desc: "There's no seat cost for the agent sitting idle between calls. You're billed per minute of actual call time." },
  { icon: Layers, title: "One number, one agent, any volume", desc: "Whether your call volume comes from ads, a directory listing, or word of mouth, the same agent handles it without added setup." },
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
            FOR INBOUND TEAMS
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Every inbound call, <span className="text-gradient">answered instantly</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            If your business gets a steady stream of inbound calls, from ads, a listing, or word
            of mouth, an AI receptionist means none of them go to voicemail.
          </p>
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

export default Publishers;
