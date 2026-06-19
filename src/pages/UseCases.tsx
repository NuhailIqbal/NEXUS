import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Stethoscope, Scale, Home, Car, GraduationCap, CreditCard, Shield, Briefcase } from "lucide-react";

const useCases = [
  {
    icon: Shield,
    vertical: "Insurance",
    title: "AI-Powered Insurance Lead Routing",
    description: "Route auto, health, life, and home insurance leads to licensed agents in real time. Our AI pre-qualifies callers, captures policy details, and matches with carriers offering the best conversion rates.",
    stats: ["$62 avg payout", "4.2x ROAS", "89% contact rate"],
  },
  {
    icon: Scale,
    vertical: "Legal",
    title: "Mass Tort & Personal Injury Distribution",
    description: "Intelligent case intake and distribution for law firms. AI agents screen callers against case criteria, collect qualifying information, and transfer to attorneys with matching practice areas.",
    stats: ["$95 avg payout", "3.8x ROAS", "92% qualification accuracy"],
  },
  {
    icon: Home,
    vertical: "Home Services",
    title: "Contractor Lead Generation",
    description: "Connect homeowners with roofing, HVAC, plumbing, and solar contractors. AI qualification captures project scope, budget, and timeline before routing to available service providers.",
    stats: ["$38 avg payout", "5.1x ROAS", "76% conversion rate"],
  },
  {
    icon: Stethoscope,
    vertical: "Healthcare",
    title: "Patient Acquisition & Scheduling",
    description: "HIPAA-compliant AI agents handle patient intake, insurance verification, and appointment scheduling for medical practices, clinics, and telehealth platforms.",
    stats: ["$44 avg payout", "3.6x ROAS", "24/7 availability"],
  },
  {
    icon: CreditCard,
    vertical: "Financial Services",
    title: "Debt Relief & Credit Repair",
    description: "Pre-screen consumers for debt settlement, credit repair, and lending products. AI agents verify income, debt levels, and eligibility before warm-transferring to financial advisors.",
    stats: ["$71 avg payout", "4.5x ROAS", "85% qualification rate"],
  },
  {
    icon: Car,
    vertical: "Automotive",
    title: "Auto Insurance & Warranty Leads",
    description: "Capture and qualify auto insurance shoppers and extended warranty prospects. Real-time integration with carrier quoting systems for instant coverage matching.",
    stats: ["$29 avg payout", "6.2x ROAS", "91% match rate"],
  },
  {
    icon: GraduationCap,
    vertical: "Education",
    title: "Student Enrollment & Program Matching",
    description: "AI-driven student intake matching prospective students with accredited programs based on career goals, schedule preferences, and financial aid eligibility.",
    stats: ["$53 avg payout", "3.9x ROAS", "82% enrollment rate"],
  },
  {
    icon: Briefcase,
    vertical: "B2B Services",
    title: "Enterprise Lead Qualification",
    description: "Qualify B2B prospects for SaaS, consulting, and professional services. AI agents capture company size, budget, timeline, and decision-maker information.",
    stats: ["$85 avg payout", "4.8x ROAS", "94% data accuracy"],
  },
];

const UseCases = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            USE CASES
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            AI Revenue Across <span className="text-gradient">Every Vertical</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            From insurance to legal, healthcare to home services — our AI infrastructure powers 
            revenue generation across 15+ industries.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {useCases.map((uc, i) => (
            <div key={uc.vertical} className="surface-card p-6 animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <uc.icon size={22} className="text-primary" />
                </div>
                <div>
                  <span className="text-xs font-mono text-primary">{uc.vertical}</span>
                  <h3 className="text-lg font-bold text-foreground">{uc.title}</h3>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">{uc.description}</p>
              <div className="flex flex-wrap gap-2">
                {uc.stats.map((s) => (
                  <span key={s} className="text-xs font-mono px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/20">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default UseCases;
