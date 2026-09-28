import {
  PhoneCall,
  Ear,
  BrainCircuit,
  AudioLines,
  ClipboardCheck,
  Languages,
  PhoneForwarded,
  RefreshCw,
  Workflow,
  KeyRound,
  UserCog,
  CreditCard,
  ShieldCheck,
  Lock,
  Wallet,
} from "lucide-react";
import {
  MarketingPage,
  PageHero,
  Section,
  IconCard,
  StatStrip,
  CtaBanner,
} from "@/components/marketing/MarketingPrimitives";
import { VOICE_COUNT, LANGUAGE_OPTIONS } from "@/lib/marketing-facts";

// The live path of a single call, in order.
const pipeline = [
  {
    icon: PhoneCall,
    title: "Connect",
    desc: "A caller rings your number, or a campaign dials a contact from your list.",
  },
  {
    icon: Ear,
    title: "Listen",
    desc: "The caller's speech is transcribed to text in real time, as they talk.",
  },
  {
    icon: BrainCircuit,
    title: "Think",
    desc: "A language model decides the reply from your prompt, knowledge and goal, or transfers the call.",
  },
  {
    icon: AudioLines,
    title: "Speak",
    desc: "The reply is spoken in the agent's voice, in a continuous back-and-forth.",
  },
  {
    icon: ClipboardCheck,
    title: "Wrap up",
    desc: "Recording, transcript, summary and cost are saved, and your automations fire.",
  },
];

const underTheHood = [
  {
    icon: Languages,
    title: "Language-aware speech",
    desc: "Each agent's transcriber and voice follow the language you pick. Urdu and multilingual agents use a speech model built for mixed-language callers.",
    badge: LANGUAGE_OPTIONS.join(" · "),
  },
  {
    icon: AudioLines,
    title: "Natural voice output",
    desc: `${VOICE_COUNT} production voices across English accents and Pakistani Urdu, each previewable in the dashboard before you assign it.`,
    badge: `${VOICE_COUNT} voices`,
  },
  {
    icon: PhoneForwarded,
    title: "Built-in transfer tool",
    desc: "When you add a transfer number, the agent gets a transfer tool it can use mid-conversation, telling the caller to hold while it connects them.",
    badge: "Mid-call",
  },
  {
    icon: RefreshCw,
    title: "Automatic call sync",
    desc: "Call results stream into your dashboard as calls end, and a background sync keeps pulling in anything that arrived late, so no call goes missing.",
    badge: "Self-healing",
  },
  {
    icon: Workflow,
    title: "Post-call automation engine",
    desc: "The moment a call ends, matching flows run their conditions and actions: texts, call-backs, webhooks and contact updates.",
    badge: "Event-driven",
  },
  {
    icon: Wallet,
    title: "Per-call cost metering",
    desc: "Each call's real voice and carrier cost is metered and deducted from your balance individually, so every charge is itemized.",
    badge: "Metered",
  },
];

const security = [
  { icon: Lock, title: "Encrypted in transit", desc: "Traffic between your browser, our servers and our providers is encrypted." },
  { icon: KeyRound, title: "Hashed passwords, verified emails", desc: "Passwords are stored only as one-way hashes, and accounts must verify their email before signing in." },
  { icon: UserCog, title: "Server-enforced roles", desc: "Owner, Member and Viewer permissions are checked on every request, not just hidden in the UI." },
  { icon: CreditCard, title: "Cards never touch our servers", desc: "Card details go straight to our payment processor. We only keep the brand and last four digits." },
  { icon: ShieldCheck, title: "Fail-safe DNC screening", desc: "With screening on, a number that can't be checked is skipped rather than dialed." },
  { icon: Wallet, title: "Balance protection", desc: "Outbound calls need a positive balance, so a campaign can't quietly run up a bill you didn't fund." },
];

const Technology = () => (
  <MarketingPage>
    <PageHero
      eyebrow="HOW IT WORKS"
      title="What happens on"
      highlight="every call"
      description="A plain look at the pipeline behind each call your agent makes or answers, and what we do to keep it reliable."
    />

    {/* Pipeline */}
    <section className="pb-6">
      <div className="container mx-auto px-4">
        <div className="glow-border rounded-2xl p-6 md:p-10 bg-card">
          <ol className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {pipeline.map((step, i) => (
              <li key={step.title} className="relative text-center">
                {i < pipeline.length - 1 && (
                  <div className="hidden lg:block absolute top-7 left-[calc(50%+2.25rem)] right-[calc(-50%+2.25rem)] h-px bg-gradient-to-r from-primary/50 to-primary/10" />
                )}
                <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                  <step.icon size={24} className="text-primary" />
                </div>
                <div className="text-[11px] font-mono text-primary mb-1">STEP {i + 1}</div>
                <h3 className="font-bold text-foreground mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.desc}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>

    <Section
      eyebrow="Under the hood"
      title="The parts that"
      highlight="make it work"
      description="Speech in, reasoning, speech out, then everything that happens after the caller hangs up."
    >
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {underTheHood.map((t) => (
          <IconCard key={t.title} {...t} />
        ))}
      </div>
    </Section>

    <Section
      eyebrow="Security & safeguards"
      title="Built to be"
      highlight="trusted with your calls"
      className="bg-secondary/20"
    >
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {security.map((s) => (
          <div key={s.title} className="flex gap-4 rounded-xl border border-border bg-card p-5">
            <s.icon size={20} className="text-primary shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-foreground text-sm">{s.title}</div>
              <p className="text-sm text-muted-foreground mt-1">{s.desc}</p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground text-center mt-8 max-w-2xl mx-auto">
        We don't currently hold SOC 2, ISO 27001 or HIPAA certification, and the platform isn't
        intended for protected health information. See our privacy policy for details.
      </p>
    </Section>

    <Section>
      <StatStrip
        stats={[
          { value: String(VOICE_COUNT), label: "Production voices" },
          { value: String(LANGUAGE_OPTIONS.length), label: "Language modes" },
          { value: "Every", label: "Call recorded" },
          { value: "24/7", label: "Inbound availability" },
        ]}
      />
    </Section>

    <CtaBanner />
  </MarketingPage>
);

export default Technology;
