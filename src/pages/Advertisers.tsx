import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { ArrowRight, Bot, ListChecks, Receipt, FileAudio, Users, Clock } from "lucide-react";
import { Link } from "react-router-dom";

const benefits = [
  { icon: Bot, title: "One agent per client", desc: "Build a separate AI voice agent for each client, each with its own goal, voice, and knowledge, all under a single account." },
  { icon: ListChecks, title: "Keep client contacts separate", desc: "Upload each client's contact list independently, group them into lists, and target campaigns without mixing data between clients." },
  { icon: Clock, title: "Launch campaigns in minutes", desc: "Point an agent at a list and go live. No scripts to hire for, no dialer to configure." },
  { icon: FileAudio, title: "Proof of work for every call", desc: "Every call comes back with a recording, transcript, and summary, an easy way to show a client exactly what was said on their behalf." },
  { icon: Receipt, title: "Itemized cost per call", desc: "See what each individual call cost, so you always know your margin before you bill a client for the campaign." },
  { icon: Users, title: "Scale up or down per client", desc: "There's no seat limit or plan tier to negotiate. Run one client's campaign or several at once, and only pay for the minutes used." },
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
            FOR AGENCIES
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Run calling campaigns <span className="text-gradient">for every client</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Build a dedicated AI voice agent for each client, launch their outbound campaigns, and
            hand back a recording and transcript of every call you made on their behalf.
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

export default Advertisers;
