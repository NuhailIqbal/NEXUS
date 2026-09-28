import {
  PhoneIncoming,
  MoonStar,
  PhoneForwarded,
  FileAudio,
  Gauge,
  Languages,
  MessageSquareText,
  BellRing,
  Phone,
  Bot,
  Headset,
  Sparkles,
} from "lucide-react";
import {
  MarketingPage,
  PageHero,
  Section,
  IconCard,
  StepList,
  CtaBanner,
  PrimaryCta,
} from "@/components/marketing/MarketingPrimitives";
import { PHONE_NUMBER_MONTHLY } from "@/lib/marketing-facts";

const benefits = [
  {
    icon: PhoneIncoming,
    title: "Never miss an inbound call",
    desc: "Every call to your number gets answered right away, whether it's the first call of the day or several at once.",
    badge: "Instant pickup",
  },
  {
    icon: MoonStar,
    title: "Cover the hours you can't",
    desc: "Evenings, weekends and holidays are covered without a night shift. The agent answers exactly as it would at 10am on a Tuesday.",
    badge: "24/7",
  },
  {
    icon: PhoneForwarded,
    title: "Hand off the calls that matter",
    desc: "The agent qualifies the caller and transfers them to your team the moment a call needs a real person. Transferred calls are flagged as qualified.",
    badge: "Live transfer",
  },
  {
    icon: Languages,
    title: "Speak your callers' language",
    desc: "Run an English or Urdu receptionist, or a multilingual one that detects the caller's language and replies in kind.",
    badge: "Multilingual",
  },
  {
    icon: MessageSquareText,
    title: "Automatic follow-up",
    desc: "When a call ends, an automation flow can text the caller, have an agent call them back, or push the lead to your CRM by webhook.",
    badge: "Automation",
  },
  {
    icon: FileAudio,
    title: "A record of every conversation",
    desc: "Recordings, transcripts and AI summaries land in your inbound call log automatically, so nothing a caller said gets lost.",
    badge: "Every call",
  },
  {
    icon: Gauge,
    title: "Only pay for connected minutes",
    desc: "No seat cost for an agent sitting idle between calls. You're billed per minute of actual call time.",
    badge: "No idle cost",
  },
  {
    icon: BellRing,
    title: "Keep the line open",
    desc: "Low-balance alerts and auto recharge top up your wallet before it runs out, so your receptionist never goes quiet.",
    badge: "Auto recharge",
  },
];

const steps = [
  { icon: Bot, title: "Build your receptionist", desc: "Tell it what your business does, paste your FAQs, and choose a voice and greeting." },
  { icon: Phone, title: "Give it a number", desc: `Buy a US local number for ${PHONE_NUMBER_MONTHLY}/month and assign it to the agent.` },
  { icon: Headset, title: "Add a transfer number", desc: "Give the agent a number to hand qualified callers to your team." },
  { icon: Sparkles, title: "Review and improve", desc: "Read the transcripts, spot what callers ask most, and refine the agent's knowledge." },
];

const Publishers = () => (
  <MarketingPage>
    <PageHero
      eyebrow="FOR INBOUND TEAMS"
      title="Every inbound call,"
      highlight="answered instantly"
      description="If your business gets a steady stream of inbound calls from ads, listings or word of mouth, an AI receptionist means none of them go to voicemail."
    >
      <PrimaryCta />
    </PageHero>

    <Section eyebrow="Why inbound teams use it" title="A receptionist that" highlight="never clocks out">
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
        {benefits.map((b) => (
          <IconCard key={b.title} {...b} />
        ))}
      </div>
    </Section>

    <Section eyebrow="Set up" title="Live on your number" highlight="in four steps" className="bg-secondary/20">
      <StepList steps={steps} />
    </Section>

    <CtaBanner
      title="Stop sending callers to voicemail"
      description="Set up an AI receptionist in minutes and pay only for the time it spends on the phone."
    />
  </MarketingPage>
);

export default Publishers;
