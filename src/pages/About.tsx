import { Headset, ShieldCheck, Sparkles, Wallet, Mail, Bot, Phone, FileAudio, Workflow } from "lucide-react";
import {
  MarketingPage,
  PageHero,
  Section,
  StatStrip,
  CtaBanner,
} from "@/components/marketing/MarketingPrimitives";
import { VOICE_COUNT, LANGUAGE_OPTIONS, INDUSTRY_COUNT } from "@/lib/marketing-facts";

const values = [
  {
    icon: Headset,
    title: "Built for real calls",
    desc: "Every feature exists because a call needed to be answered, transferred or followed up, not because it looked good on a roadmap.",
  },
  {
    icon: Sparkles,
    title: "No black boxes",
    desc: "Every call comes back with its recording, transcript and summary attached. You should never have to wonder what was said.",
  },
  {
    icon: Wallet,
    title: "Pay for what you use",
    desc: "No seat licenses, tiered plans or annual contracts. You top up a balance and calls draw it down, minute by minute.",
  },
  {
    icon: ShieldCheck,
    title: "You stay in control",
    desc: "You decide who your agents call, what they say and when they hand off. We give you the tools, and the judgment calls stay with you.",
  },
];

// A short tour of what the platform covers today, in the order a new account uses it.
const platform = [
  { icon: Bot, title: "Build", desc: "A guided builder, website auto-fill, prompt studio and a live test call in the browser." },
  { icon: Phone, title: "Call", desc: "Outbound campaigns, an AI receptionist, live transfer, DNC screening and phone numbers." },
  { icon: FileAudio, title: "Review", desc: "Recordings, speaker-labelled transcripts, AI summaries, call logs and analytics." },
  { icon: Workflow, title: "Automate", desc: "Post-call flows that text, call back, update contacts and fire webhooks." },
];

const About = () => (
  <MarketingPage>
    <PageHero
      eyebrow="ABOUT EDM NEXUS"
      title="An AI agent for"
      highlight="your phone line"
      description="EDM Nexus lets any business build an AI voice agent, put it on a real phone number, and have it make or answer calls, with every call recorded, transcribed and billed by the minute."
    />

    <section className="pb-6">
      <div className="container mx-auto px-4">
        <div className="glow-border rounded-2xl p-8 md:p-12 text-center bg-card">
          <h2 className="text-2xl md:text-3xl font-bold text-foreground mb-4">Why we built this</h2>
          <p className="text-muted-foreground text-base md:text-lg max-w-3xl mx-auto leading-relaxed">
            Most of the calls that matter to a small or mid-size business never get made: the
            after-hours enquiry, the appointment reminder, the lead that went cold. There's simply
            no one free to make them. We built EDM Nexus so a team can put an AI agent on the phone
            in minutes, without hiring, scripting a call center or signing a contract, and still
            see exactly what happened on every call.
          </p>
        </div>
      </div>
    </section>

    <Section eyebrow="What we believe" title="The principles" highlight="behind the product">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {values.map((v) => (
          <div key={v.title} className="surface-card p-6 text-center">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
              <v.icon size={22} className="text-primary" />
            </div>
            <h3 className="font-bold text-foreground mb-2">{v.title}</h3>
            <p className="text-sm text-muted-foreground">{v.desc}</p>
          </div>
        ))}
      </div>
    </Section>

    <Section eyebrow="The platform today" title="One dashboard," highlight="the whole call" className="bg-secondary/20">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-10">
        {platform.map((p) => (
          <div key={p.title} className="surface-card p-6">
            <p.icon size={20} className="text-primary mb-3" />
            <h3 className="font-bold text-foreground mb-1.5">{p.title}</h3>
            <p className="text-sm text-muted-foreground">{p.desc}</p>
          </div>
        ))}
      </div>
      <StatStrip
        stats={[
          { value: String(VOICE_COUNT), label: "Production voices" },
          { value: String(LANGUAGE_OPTIONS.length), label: "Language modes" },
          { value: String(INDUSTRY_COUNT), label: "Industries" },
          { value: "$0", label: "Monthly platform fee" },
        ]}
      />
    </Section>

    <Section eyebrow="Get in touch" title="Talk to" highlight="a person">
      <div className="max-w-xl mx-auto text-center">
        <p className="text-muted-foreground mb-6">
          Questions about the product, a custom rate or your account? Email us and a member of the
          team will get back to you.
        </p>
        <a
          href="mailto:edmnexusai@gmail.com"
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-5 py-3 text-sm font-medium text-foreground hover:border-primary/40 transition-colors"
        >
          <Mail size={16} className="text-primary" /> edmnexusai@gmail.com
        </a>
      </div>
    </Section>

    <CtaBanner />
  </MarketingPage>
);

export default About;
