import {
  Bot,
  ListChecks,
  Rocket,
  FileAudio,
  Receipt,
  Users,
  ShieldCheck,
  Webhook,
  BarChart3,
  UserPlus,
  Phone,
  ClipboardCheck,
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
import { CAMPAIGN_BATCH_SIZE, INDUSTRY_COUNT, VOICE_COUNT } from "@/lib/marketing-facts";

const benefits = [
  {
    icon: Bot,
    title: "A dedicated agent per client",
    desc: `Give each client their own agent with its own goal, voice, knowledge and transfer number. Tag it with one of ${INDUSTRY_COUNT} industries and duplicate a winning setup for the next client.`,
    badge: "Unlimited agents",
  },
  {
    icon: ListChecks,
    title: "Client lists kept separate",
    desc: "Import each client's contacts from CSV into their own list, so a campaign only ever dials the people it's meant to.",
    badge: "CSV import",
  },
  {
    icon: Rocket,
    title: "Launch in minutes",
    desc: `A three-step campaign wizard and a pre-launch check, then calls go out ${CAMPAIGN_BATCH_SIZE} at a time. No dialer to configure, no callers to hire.`,
    badge: "Self-serve",
  },
  {
    icon: ShieldCheck,
    title: "DNC screening per campaign",
    desc: "Switch on do-not-call screening for any campaign and numbers on DNC or known-litigator lists are skipped before they're dialed.",
    badge: "Compliance aid",
  },
  {
    icon: FileAudio,
    title: "Proof of work on every call",
    desc: "Recordings, speaker-labelled transcripts and AI summaries for every call you made on a client's behalf. Play them back or download the audio.",
    badge: "Every call",
  },
  {
    icon: Receipt,
    title: "Know your margin",
    desc: "Every call's duration and exact charge is itemized, so you know your cost per campaign before you invoice the client.",
    badge: "Itemized",
  },
  {
    icon: BarChart3,
    title: "Campaign reporting",
    desc: "Contacts, completed calls, qualified leads and progress for each campaign, plus a by-agent breakdown for side-by-side comparisons.",
    badge: "Per campaign",
  },
  {
    icon: Webhook,
    title: "Results into their CRM",
    desc: "Automation flows can post call results to any webhook, text the lead, or update the contact the moment a call ends.",
    badge: "Automation",
  },
  {
    icon: Users,
    title: "Bring your team",
    desc: "Invite account managers as Members to build and run campaigns, or as Viewers with read-only access. No seat fees.",
    badge: "No seat limit",
  },
];

const steps = [
  { icon: UserPlus, title: "Sign up once", desc: "One account for your agency. Verify your email and $20 of credit is added." },
  { icon: Bot, title: "Build per client", desc: `Create an agent for each client and pick from ${VOICE_COUNT} voices. Test it live in the browser.` },
  { icon: Phone, title: "Add numbers & lists", desc: "Buy a number for each client's campaign and import their contact list." },
  { icon: ClipboardCheck, title: "Launch & report", desc: "Run the campaign, then hand back recordings, transcripts and results." },
];

const Advertisers = () => (
  <MarketingPage>
    <PageHero
      eyebrow="FOR AGENCIES"
      title="Run calling campaigns"
      highlight="for every client"
      description="Build a dedicated AI voice agent for each client, launch their outbound campaigns, and hand back a recording and transcript of every call you made on their behalf."
    >
      <PrimaryCta />
    </PageHero>

    <Section eyebrow="Why agencies use it" title="One account," highlight="many clients">
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
        {benefits.map((b) => (
          <IconCard key={b.title} {...b} />
        ))}
      </div>
    </Section>

    <Section eyebrow="How it works" title="From new client to" highlight="first campaign" className="bg-secondary/20">
      <StepList steps={steps} />
    </Section>

    <CtaBanner
      title="Take on more calling work without more callers"
      description="Pay only for the minutes each client's campaign uses. No subscriptions, seat licenses or annual contracts."
    />
  </MarketingPage>
);

export default Advertisers;
