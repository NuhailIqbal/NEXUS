import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sparkles, ArrowRight, CheckCircle2 } from "lucide-react";
import { useState } from "react";

const benefits = [
  "AI-powered call routing & optimization",
  "Access to 500+ premium buyers",
  "Real-time analytics dashboard",
  "Dedicated account management",
  "24/7 multilingual AI agents",
];

const RequestAccess = () => {
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <div className="min-h-screen bg-background">
        <Navbar />
        <section className="relative min-h-screen flex items-center justify-center pt-16">
          <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
          <div className="text-center px-4 relative z-10">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-6">
              <CheckCircle2 size={32} className="text-primary" />
            </div>
            <h1 className="text-3xl font-black text-foreground mb-3">Request Received</h1>
            <p className="text-muted-foreground max-w-md mx-auto">
              Thank you for your interest in EDM Nexus. Our team will review your application 
              and reach out within 24 hours.
            </p>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden">
        <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
        <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[500px] h-[500px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

        <div className="container mx-auto px-4 relative z-10">
          <div className="grid md:grid-cols-2 gap-12 max-w-4xl mx-auto items-center">
            {/* Left side */}
            <div>
              <div className="badge-pill mb-6">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
                GET STARTED
              </div>
              <h1 className="text-3xl md:text-4xl font-black text-foreground mb-4">
                Request <span className="text-gradient">Platform Access</span>
              </h1>
              <p className="text-muted-foreground mb-8">
                Join the leading AI-powered revenue platform. Our team will set you up 
                with a customized solution for your business.
              </p>
              <ul className="space-y-3">
                {benefits.map((b) => (
                  <li key={b} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <CheckCircle2 size={16} className="text-primary shrink-0" />
                    {b}
                  </li>
                ))}
              </ul>
            </div>

            {/* Right side - Form */}
            <div className="surface-card p-6">
              <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setSubmitted(true); }}>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">First Name</label>
                    <Input placeholder="John" className="bg-background border-border" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Last Name</label>
                    <Input placeholder="Smith" className="bg-background border-border" />
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Work Email</label>
                  <Input type="email" placeholder="john@company.com" className="bg-background border-border" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Company</label>
                  <Input placeholder="Company name" className="bg-background border-border" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Phone</label>
                  <Input type="tel" placeholder="(555) 000-0000" className="bg-background border-border" />
                </div>
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">I am a...</label>
                  <select className="w-full h-10 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
                    <option value="">Select one</option>
                    <option value="advertiser">Advertiser / Buyer</option>
                    <option value="publisher">Publisher / Affiliate</option>
                    <option value="agency">Agency</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90 gap-2" type="submit">
                  <Sparkles size={16} /> Submit Request <ArrowRight size={16} />
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  By submitting, you agree to our terms of service and privacy policy.
                </p>
              </form>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};

export default RequestAccess;
