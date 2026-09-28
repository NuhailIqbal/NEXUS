import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Shield,
  Gavel,
  ClipboardList,
  HeartPulse,
  Landmark,
  Car,
  GraduationCap,
  Handshake,
  Home,
  Wallet,
  Plane,
  ShoppingBag,
  Wifi,
  Briefcase,
  PhoneIncoming,
  PhoneOutgoing,
} from "lucide-react";
import { MarketingPage, PageHero, Section, CtaBanner } from "@/components/marketing/MarketingPrimitives";
import { INDUSTRY_COUNT } from "@/lib/marketing-facts";

type Direction = "Inbound" | "Outbound";
type UseCase = {
  icon: LucideIcon;
  vertical: string;
  title: string;
  description: string;
  direction: Direction;
  tags: string[];
};

// Verticals match the industry list in the agent builder (src/lib/industries.ts), and
// every tag names a part of the product that exists today.
const useCases: UseCase[] = [
  {
    icon: Shield,
    vertical: "Insurance",
    title: "Renewal reminders and policy check-ins",
    description: "Call policyholders ahead of renewal, confirm their details, and transfer anyone who wants to talk to a licensed agent before their policy lapses.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Live transfer", "DNC screening"],
  },
  {
    icon: Home,
    vertical: "Real Estate",
    title: "Buyer and seller lead follow-up",
    description: "Work through your list of new buyer and seller leads, ask about budget, timeline and area, and pass the serious ones straight to an agent while they're still on the line.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Live transfer", "Qualified flag"],
  },
  {
    icon: Gavel,
    vertical: "Legal Services",
    title: "Intake screening for new enquiries",
    description: "Answer calls from prospective clients, work through your intake questions, and transfer qualified callers to an attorney immediately.",
    direction: "Inbound",
    tags: ["AI receptionist", "Live transfer", "Transcripts"],
  },
  {
    icon: ClipboardList,
    vertical: "Home Services & Contracting",
    title: "Quote requests and job intake",
    description: "Pick up every homeowner's call, capture the job details, and text them a confirmation automatically once the call ends.",
    direction: "Inbound",
    tags: ["AI receptionist", "SMS follow-up", "AI summary"],
  },
  {
    icon: HeartPulse,
    vertical: "Healthcare & Medical",
    title: "Appointment reminders and rescheduling",
    description: "Call ahead of upcoming appointments to confirm, reschedule or flag likely no-shows. Not intended for handling protected health information.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Contact list"],
  },
  {
    icon: Wallet,
    vertical: "Debt & Credit Services",
    title: "Payment reminders and hardship triage",
    description: "Place routine reminder calls with DNC screening switched on, and transfer anyone asking about a plan to your team, with a transcript of every call kept.",
    direction: "Outbound",
    tags: ["DNC screening", "Live transfer", "Transcripts"],
  },
  {
    icon: Landmark,
    vertical: "Finance & Banking",
    title: "Application status and document chasing",
    description: "Call applicants who haven't sent their paperwork, explain what's missing, and update their contact status automatically after the call.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Automation", "Contact updates"],
  },
  {
    icon: Car,
    vertical: "Automotive Industry",
    title: "Service reminders and post-visit check-ins",
    description: "Remind customers when a vehicle is due for service, and follow up after a visit to make sure they were happy with the work.",
    direction: "Outbound",
    tags: ["Outbound campaign", "AI summary"],
  },
  {
    icon: GraduationCap,
    vertical: "Education",
    title: "Enrollment follow-ups",
    description: "Call prospective students who started an application but didn't finish, answer common questions, and connect them with admissions.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Live transfer"],
  },
  {
    icon: Plane,
    vertical: "Travel & Hospitality",
    title: "Reservations line and after-hours desk",
    description: "Answer booking and availability questions around the clock from your knowledge base, and transfer group or special requests to staff.",
    direction: "Inbound",
    tags: ["AI receptionist", "24/7", "Knowledge"],
  },
  {
    icon: ShoppingBag,
    vertical: "Retail & E-commerce",
    title: "Order questions and support triage",
    description: "Handle the questions that come up constantly, like shipping, returns and store hours, and pass anything unusual to a person.",
    direction: "Inbound",
    tags: ["AI receptionist", "Live transfer", "Knowledge"],
  },
  {
    icon: Wifi,
    vertical: "Telecommunications & Internet",
    title: "Multilingual customer lines",
    description: "Serve English and Urdu-speaking customers from the same number with a multilingual agent that answers in the caller's language.",
    direction: "Inbound",
    tags: ["Multilingual", "AI receptionist", "Urdu voices"],
  },
  {
    icon: Briefcase,
    vertical: "SaaS & Technology",
    title: "Trial and demo follow-up",
    description: "Call trial sign-ups who went quiet, find out what's blocking them, and send the interested ones to sales by webhook.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Webhook", "Automation"],
  },
  {
    icon: Handshake,
    vertical: "Marketing & Professional Services",
    title: "Re-engaging cold leads",
    description: "Work back through a list of leads that went quiet and find out who's still interested, without tying up your team for days.",
    direction: "Outbound",
    tags: ["Outbound campaign", "Contact list", "Analytics"],
  },
];

const filters: ("All" | Direction)[] = ["All", "Inbound", "Outbound"];

const UseCases = () => {
  const [filter, setFilter] = useState<"All" | Direction>("All");
  const visible = filter === "All" ? useCases : useCases.filter((u) => u.direction === filter);

  return (
    <MarketingPage>
      <PageHero
        eyebrow="USE CASES"
        title="The same platform,"
        highlight="any industry"
        description={`Every example below is built from the same pieces: an agent, a phone number, and optionally a contact list and an automation. Agents can be tagged with any of ${INDUSTRY_COUNT} industries.`}
      />

      <Section className="pt-0 md:pt-0">
        <div className="flex justify-center mb-10">
          <div className="inline-flex rounded-full border border-border bg-card p-1" role="tablist" aria-label="Filter use cases">
            {filters.map((f) => (
              <button
                key={f}
                role="tab"
                aria-selected={filter === f}
                onClick={() => setFilter(f)}
                className={`px-4 sm:px-5 py-2 rounded-full text-sm font-medium transition-colors ${
                  filter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {visible.map((uc) => {
            const DirIcon = uc.direction === "Inbound" ? PhoneIncoming : PhoneOutgoing;
            return (
              <div key={uc.vertical} className="surface-card p-6 flex flex-col">
                <div className="flex items-start gap-3 mb-4">
                  <div className="w-12 h-12 shrink-0 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <uc.icon size={22} className="text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="text-xs font-mono text-primary">{uc.vertical}</span>
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <DirIcon size={12} /> {uc.direction}
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-foreground">{uc.title}</h3>
                  </div>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">{uc.description}</p>
                <div className="flex flex-wrap gap-2 mt-auto">
                  {uc.tags.map((t) => (
                    <span key={t} className="text-xs font-mono px-2 py-1 rounded-md bg-primary/10 text-primary border border-primary/20">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <CtaBanner title="Your use case not listed?" description="If it happens on a phone call, an agent can probably handle it. Build one and test it live in the browser before it calls anyone." />
    </MarketingPage>
  );
};

export default UseCases;
