import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Check, ArrowRight, Gift } from "lucide-react";
import { Link } from "react-router-dom";

const included = [
  "Unlimited AI agents",
  "13 production voices, 5 languages",
  "Outbound campaigns with CSV import",
  "24/7 AI receptionist for inbound calls",
  "Call recording, transcripts, and AI summaries on every call",
  "Live transfer to a human",
  "Contacts, lists, and custom fields",
  "Itemized cost on every single call",
];

const Pricing = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            PRICING
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            One rate. <span className="text-gradient">No plans to pick.</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Every feature is available to every account from day one. You only pay for the minutes
            your agents are actually on a call.
          </p>
        </div>

        <div className="max-w-lg mx-auto animate-slide-up" style={{ animationDelay: "0.3s" }}>
          <div className="glow-border rounded-2xl p-8 bg-card">
            <div className="text-center mb-6">
              <div className="text-5xl font-black text-gradient mb-2">~$0.35</div>
              <p className="text-sm text-muted-foreground">per minute, billed at the call's actual cost</p>
            </div>

            <div className="flex items-center justify-center gap-2 mb-6 px-4 py-2 rounded-lg bg-primary/10 text-sm text-primary">
              <Gift size={16} /> New accounts start with $20 in free credit
            </div>

            <ul className="space-y-3 mb-8">
              {included.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Check size={16} className="text-primary mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>

            <Link to="/register">
              <Button className="w-full gap-2 bg-primary text-primary-foreground hover:bg-primary/90">
                Start with $20 free credit <ArrowRight size={16} />
              </Button>
            </Link>

            <p className="text-xs text-muted-foreground text-center mt-4">
              Phone numbers are $3/month each, charged from the same balance. No card required to
              sign up.
            </p>
          </div>
        </div>

        <div className="text-center mt-12 animate-slide-up" style={{ animationDelay: "0.4s" }}>
          <p className="text-sm text-muted-foreground">
            Running a high volume of calls?{" "}
            <Link to="/request-access" className="text-primary hover:underline">Contact us</Link> about a custom rate.
          </p>
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Pricing;
