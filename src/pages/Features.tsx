import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import {
  Bot,
  PhoneOutgoing,
  PhoneIncoming,
  FileAudio,
  Users,
  CreditCard,
  Mic,
  PhoneForwarded,
  FileText,
  Sparkles,
  Phone,
  Bell,
} from "lucide-react";

const features = [
  {
    icon: Bot,
    title: "Guided Agent Builder",
    description: "Set your agent's goal, industry, and knowledge through a guided setup, then test it in the same session before it ever dials out.",
    highlight: "No code required",
  },
  {
    icon: PhoneOutgoing,
    title: "Outbound Campaigns",
    description: "Point an agent at a contact list and launch. Every call attempt and its outcome is logged automatically.",
    highlight: "CSV import",
  },
  {
    icon: PhoneIncoming,
    title: "AI Receptionist",
    description: "Assign an agent to a phone number and it answers inbound calls around the clock, including outside business hours.",
    highlight: "24/7 answering",
  },
  {
    icon: PhoneForwarded,
    title: "Live Call Transfer",
    description: "When a call needs a human, the agent can transfer it directly to your team instead of ending the conversation.",
    highlight: "Mid-call handoff",
  },
  {
    icon: FileAudio,
    title: "Call Recording",
    description: "Every call is recorded by default, so you can listen back to exactly what was said.",
    highlight: "Every call",
  },
  {
    icon: FileText,
    title: "Speaker-Labelled Transcripts",
    description: "Each recording comes with a written transcript that shows who said what, so you don't have to replay the audio to check details.",
    highlight: "Full transcript",
  },
  {
    icon: Sparkles,
    title: "AI Call Summaries",
    description: "A short automatic write-up of what happened on the call, generated right after it ends.",
    highlight: "Auto-generated",
  },
  {
    icon: Mic,
    title: "13 Production Voices",
    description: "Choose from a roster of American, Canadian, and Indian-American voices and preview any of them before assigning one to an agent.",
    highlight: "13 voices",
  },
  {
    icon: Users,
    title: "Contacts, Lists & Custom Fields",
    description: "Import contacts from CSV, organize them into lists for targeting, and add your own fields to track whatever matters to your business.",
    highlight: "CSV + custom fields",
  },
  {
    icon: Phone,
    title: "Phone Number Provisioning",
    description: "Get a phone number in the area code you want directly from the dashboard, then assign it to any agent.",
    highlight: "$3/month",
  },
  {
    icon: CreditCard,
    title: "Per-Call Billing",
    description: "See exactly what each call cost, down to the individual charge. No estimates, no bundled minutes.",
    highlight: "Itemized costs",
  },
  {
    icon: Bell,
    title: "Balance Alerts & Auto Recharge",
    description: "Get notified as your credit runs low, or turn on auto recharge so a saved card tops up your balance automatically.",
    highlight: "Never run dry",
  },
];

const Features = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            PLATFORM CAPABILITIES
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            Everything to put an agent <span className="text-gradient">on the phone</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            From building the agent to seeing exactly what each call cost, it's all in one
            dashboard.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <div
              key={f.title}
              className="surface-card p-6 animate-slide-up group"
              style={{ animationDelay: `${0.05 * i}s` }}
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <f.icon size={22} className="text-primary" />
                </div>
                <span className="text-xs font-mono text-primary bg-primary/10 px-2 py-1 rounded-md">
                  {f.highlight}
                </span>
              </div>
              <h3 className="text-lg font-bold text-foreground mb-2">{f.title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Features;
