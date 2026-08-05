import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Stethoscope, Scale, Home, Car, GraduationCap, CreditCard, Shield, Briefcase } from "lucide-react";

const useCases = [
  {
    icon: Shield,
    vertical: "Insurance",
    title: "Renewal reminders and policy check-ins",
    description: "Call policyholders ahead of renewal, confirm details, and flag anyone who wants to talk to an agent before their policy lapses.",
    tags: ["Outbound campaign", "Live transfer"],
  },
  {
    icon: Scale,
    vertical: "Legal",
    title: "Intake screening for new enquiries",
    description: "Answer calls from prospective clients, ask your intake questions, and pass qualified callers straight to an attorney while they're still on the line.",
    tags: ["Inbound agent", "Live transfer"],
  },
  {
    icon: Home,
    vertical: "Home Services",
    title: "Quote requests and job scheduling",
    description: "Take inbound calls from homeowners requesting a quote, capture the job details, and book a time for a technician to follow up.",
    tags: ["Inbound agent", "Custom fields"],
  },
  {
    icon: Stethoscope,
    vertical: "Healthcare & Wellness",
    title: "Appointment reminders and rescheduling",
    description: "Call ahead of upcoming appointments to confirm, reschedule, or flag likely no-shows. Not intended for handling protected health information.",
    tags: ["Outbound campaign", "Contact list"],
  },
  {
    icon: CreditCard,
    vertical: "Financial Services",
    title: "Payment reminders and status calls",
    description: "Place routine calls about upcoming payments or application status, with a transcript kept for every conversation.",
    tags: ["Outbound campaign", "Transcripts"],
  },
  {
    icon: Car,
    vertical: "Automotive",
    title: "Service reminders and follow-ups",
    description: "Remind customers when a vehicle is due for service, and follow up after a visit to check they're satisfied.",
    tags: ["Outbound campaign", "AI summary"],
  },
  {
    icon: GraduationCap,
    vertical: "Education",
    title: "Enrollment follow-ups",
    description: "Call prospective students who started an application but didn't finish, answer common questions, and offer to connect them with admissions.",
    tags: ["Outbound campaign", "Live transfer"],
  },
  {
    icon: Briefcase,
    vertical: "B2B Services",
    title: "Lead follow-up and re-engagement",
    description: "Work back through a list of leads that went quiet and find out who's still interested, without tying up your sales team for days.",
    tags: ["Outbound campaign", "Contact list"],
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
            The same platform, <span className="text-gradient">any industry</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            Every example below uses the same building blocks: an agent, a phone number, and
            optionally a contact list.
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
                {uc.tags.map((t) => (
                  <span key={t} className="text-xs font-mono px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/20">
                    {t}
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
