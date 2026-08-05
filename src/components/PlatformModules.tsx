import { Bot, PhoneOutgoing, PhoneIncoming, FileAudio, Users, CreditCard } from "lucide-react";

// Each module below is a real section of the dashboard — the feature chips and the
// stat are things the platform actually does today, not aspirational copy.
const modules = [
  {
    icon: Bot,
    tag: "Build in minutes",
    title: "AI Voice Agents",
    description:
      "A guided setup walks you through the agent's goal, industry, voice and knowledge, then lets you test it before it ever dials out.",
    features: ["Knowledge upload", "Custom system prompt", "Voice selection", "Test before launch"],
    stat: "13",
    statLabel: "built-in voices",
  },
  {
    icon: PhoneOutgoing,
    tag: "Dial at scale",
    title: "Outbound Campaigns",
    description:
      "Point an agent at a contact list and launch. Calls are placed in batches and every attempt is logged with its outcome.",
    features: ["CSV contact import", "List targeting", "Campaign analytics", "Full call logs"],
    stat: "CSV",
    statLabel: "list import",
  },
  {
    icon: PhoneIncoming,
    tag: "Never miss a call",
    title: "AI Receptionist",
    description:
      "Assign an agent to your number and it answers inbound calls, qualifies the caller, and transfers to a human when it matters.",
    features: ["Inbound call logs", "Agent per number", "Live transfer", "After-hours cover"],
    stat: "24/7",
    statLabel: "always answering",
  },
  {
    icon: FileAudio,
    tag: "Full call history",
    title: "Recordings & Transcripts",
    description:
      "Every call is recorded and transcribed with speaker labels, plus an AI summary. All of it is pulled into your dashboard automatically.",
    features: ["Audio playback", "Speaker transcript", "Call summary", "Automatic sync"],
    stat: "Every",
    statLabel: "call recorded",
  },
  {
    icon: Users,
    tag: "Your data",
    title: "Contacts & Lists",
    description:
      "Import your contacts from CSV, group them into lists for targeting, and add your own fields to track whatever matters to you.",
    features: ["CSV import", "Lists & segments", "Custom fields", "Consent tracking"],
    stat: "Custom",
    statLabel: "fields per contact",
  },
  {
    icon: CreditCard,
    tag: "Pay as you go",
    title: "Numbers & Billing",
    description:
      "Provision a phone number, top up a balance, and see the exact cost of every single call. No plans, no monthly commitment.",
    features: ["Phone numbers", "Wallet balance", "Auto recharge", "Per-call costs"],
    stat: "~$0.35",
    statLabel: "per minute",
  },
];

const PlatformModules = () => (
  <section id="features" className="py-24 relative">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">THE PLATFORM</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          Everything you need to <span className="text-gradient">run AI phone calls</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          Six parts of the platform, all in one dashboard, from building the agent to seeing what
          each call cost.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {modules.map((mod) => (
          <div key={mod.title} className="surface-card p-6 flex flex-col gap-4 group">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <mod.icon size={20} className="text-primary" />
              </div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{mod.tag}</span>
            </div>

            <h3 className="text-xl font-bold text-foreground">{mod.title}</h3>
            <p className="text-sm text-muted-foreground">{mod.description}</p>

            <div className="flex flex-wrap gap-2 mt-auto">
              {mod.features.map((f) => (
                <span key={f} className="text-xs px-2.5 py-1 rounded-md bg-secondary text-secondary-foreground">{f}</span>
              ))}
            </div>

            <div className="pt-4 border-t border-border flex items-baseline gap-2">
              <span className="text-3xl font-black text-gradient">{mod.stat}</span>
              <span className="text-sm text-muted-foreground">{mod.statLabel}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default PlatformModules;
