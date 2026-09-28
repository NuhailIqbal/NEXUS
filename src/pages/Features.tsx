import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Globe,
  BookOpen,
  Mic,
  Languages,
  PlayCircle,
  PhoneOutgoing,
  PhoneIncoming,
  PhoneForwarded,
  Phone,
  ShieldCheck,
  FileAudio,
  FileText,
  Sparkles,
  MessagesSquare,
  BarChart3,
  Workflow,
  MessageSquareText,
  Webhook,
  History,
  Users,
  UserCog,
  Search,
  Wallet,
  Bell,
  ListChecks,
} from "lucide-react";
import {
  MarketingPage,
  PageHero,
  Section,
  IconCard,
  StatStrip,
  CtaBanner,
} from "@/components/marketing/MarketingPrimitives";
import {
  VOICE_COUNT,
  INDUSTRY_COUNT,
  LANGUAGE_OPTIONS,
  PHONE_NUMBER_MONTHLY,
  CAMPAIGN_BATCH_SIZE,
} from "@/lib/marketing-facts";

type Feature = { icon: LucideIcon; title: string; desc: string; badge?: string; points?: string[] };
type Group = { id: string; eyebrow: string; title: string; highlight: string; description: string; features: Feature[] };

// Every card maps to a shipped part of the dashboard. If a feature isn't live, it
// doesn't go on this page.
const groups: Group[] = [
  {
    id: "build",
    eyebrow: "01 · Build",
    title: "Build an agent",
    highlight: "in one sitting",
    description: "A guided four-step builder takes you from a blank page to an agent you've already talked to.",
    features: [
      {
        icon: Bot,
        title: "Guided agent builder",
        desc: "Setup, Knowledge, Prompt Studio and Testing, in that order. Name the agent, give it a goal, pick an industry and voice, and you're most of the way there.",
        badge: "No code",
        points: ["Unlimited agents per account", "Duplicate an agent to reuse a setup", "Edit voice, prompt or transfer number any time"],
      },
      {
        icon: Globe,
        title: "Start from your website",
        desc: "Paste your site's URL and hit Analyze. The builder reads the page and suggests the agent's main goal for you to accept or edit.",
        badge: "Auto-fill",
      },
      {
        icon: BookOpen,
        title: "Knowledge & Prompt Studio",
        desc: "Paste your FAQs, pricing or policies as the agent's knowledge, then fine-tune the system prompt and the greeting it opens every call with.",
        badge: "8,000 chars",
      },
      {
        icon: ListChecks,
        title: `${INDUSTRY_COUNT} industries`,
        desc: "Tag each agent with its industry, from insurance and real estate to legal, healthcare, debt services and telecom, so your roster stays organized.",
        badge: "Searchable",
      },
      {
        icon: Mic,
        title: `${VOICE_COUNT} production voices`,
        desc: "American, Canadian, Indian-American and Asian-American English voices, plus two Pakistani Urdu voices. Preview any of them with your own sample line.",
        badge: `${VOICE_COUNT} voices`,
      },
      {
        icon: Languages,
        title: "English, Urdu or multilingual",
        desc: "Pick a language per agent. Urdu agents reply in Roman Urdu, and multilingual agents detect the caller's language and answer in kind.",
        badge: `${LANGUAGE_OPTIONS.length} modes`,
      },
      {
        icon: PlayCircle,
        title: "Test before it dials",
        desc: "Talk to your agent in the browser with a live voice call, or chat with it in text, before it ever touches a real phone line.",
        badge: "Live voice test",
      },
    ],
  },
  {
    id: "call",
    eyebrow: "02 · Call",
    title: "Make and answer",
    highlight: "real phone calls",
    description: "Put an agent on a number and it starts working, outbound, inbound, or both.",
    features: [
      {
        icon: PhoneOutgoing,
        title: "Outbound campaigns",
        desc: "Pick an agent, a contact list and a number to call from, then launch. A pre-launch check confirms everything is ready before the first dial.",
        badge: `${CAMPAIGN_BATCH_SIZE} at a time`,
        points: ["Calls placed in concurrent batches", "Live progress and completion tracking", "Pause or resume from the campaign list"],
      },
      {
        icon: PhoneIncoming,
        title: "AI receptionist",
        desc: "Assign an agent to a number and every inbound call gets answered, including evenings, weekends and holidays.",
        badge: "24/7",
      },
      {
        icon: PhoneForwarded,
        title: "Live call transfer",
        desc: "Give the agent a transfer number and it hands qualified or complicated callers to your team mid-call instead of hanging up.",
        badge: "Warm handoff",
      },
      {
        icon: Phone,
        title: "Phone numbers",
        desc: "Buy a US local number from the dashboard, set it for inbound, outbound or both, assign an agent, and place a test call to hear it working.",
        badge: `${PHONE_NUMBER_MONTHLY}/month`,
      },
      {
        icon: ShieldCheck,
        title: "Do-not-call screening",
        desc: "Turn on DNC screening for a campaign and numbers on do-not-call or known-litigator lists are skipped automatically, with a notification for each one.",
        badge: "Optional",
      },
    ],
  },
  {
    id: "review",
    eyebrow: "03 · Review",
    title: "See exactly what happened",
    highlight: "on every call",
    description: "Nothing disappears into a black box. Each call comes back with its audio, words and outcome attached.",
    features: [
      {
        icon: FileAudio,
        title: "Call recordings",
        desc: "Every call is recorded. Play it back at 1×, 1.5× or 2×, or download the audio.",
        badge: "Every call",
      },
      {
        icon: FileText,
        title: "Speaker-labelled transcripts",
        desc: "See who said what. Click any line of the transcript to jump straight to that moment in the recording.",
        badge: "Click to seek",
      },
      {
        icon: Sparkles,
        title: "AI call summaries",
        desc: "A few bullet points on what was discussed, the next steps and the caller's sentiment, written as soon as the call ends.",
        badge: "Auto-generated",
      },
      {
        icon: MessagesSquare,
        title: "All conversations in one place",
        desc: "Filter every call by agent, contact, status, direction, qualification or date, with separate inbound and outbound call logs.",
        badge: "Filterable",
      },
      {
        icon: BarChart3,
        title: "Analytics",
        desc: "Call volume, completion and qualification at a glance, a 14-day trend, and breakdowns by campaign and by agent.",
        badge: "3 views",
      },
    ],
  },
  {
    id: "automate",
    eyebrow: "04 · Automate",
    title: "Follow up",
    highlight: "without lifting a finger",
    description: "Drag-and-drop flows that run the moment a call ends, so the next step happens automatically.",
    features: [
      {
        icon: Workflow,
        title: "Visual flow builder",
        desc: "Chain triggers, logic and actions on a canvas. Flows fire when an inbound or web call ends.",
        badge: "Drag & drop",
        points: ["Condition, Delay and Split operators", "Personalize with {{contact_name}}, {{duration}} and more"],
      },
      {
        icon: MessageSquareText,
        title: "SMS and call-back actions",
        desc: "Text the caller from your own number, or have an agent call them back, based on how the call went.",
        badge: "Actions",
      },
      {
        icon: Webhook,
        title: "Webhooks & contact updates",
        desc: "Push call results to your CRM or any system with a webhook, and update the contact's status automatically.",
        badge: "Connect anything",
      },
      {
        icon: History,
        title: "Versions and run history",
        desc: "Every saved flow keeps its version history so you can roll back, and every run is logged so you can see what fired.",
        badge: "Audit trail",
      },
    ],
  },
  {
    id: "manage",
    eyebrow: "05 · Manage",
    title: "Run the whole account",
    highlight: "from one dashboard",
    description: "Contacts, teammates and money, all without leaving the dashboard.",
    features: [
      {
        icon: Users,
        title: "Contacts & lists",
        desc: "Import contacts from CSV straight into a new or existing list, or add them one by one, then target a list with a campaign.",
        badge: "CSV import",
      },
      {
        icon: UserCog,
        title: "Team roles",
        desc: "Invite teammates by email as a Member who can build and edit, or a Viewer with read-only access. Only the owner can delete.",
        badge: "Owner · Member · Viewer",
      },
      {
        icon: Search,
        title: "Global search & quick setup",
        desc: "Jump to any agent, contact, number or campaign from one search box, and follow a guided checklist from sign-up to your first campaign.",
        badge: "Get started fast",
      },
      {
        icon: Wallet,
        title: "Prepaid wallet & itemized costs",
        desc: "Top up a balance, save a card, redeem promo codes, and see the duration and charge of every single call.",
        badge: "Pay as you go",
      },
      {
        icon: Bell,
        title: "Alerts & auto recharge",
        desc: "Get notified as your balance runs low, or let a saved card top it up automatically so campaigns and inbound lines never stop.",
        badge: "Never run dry",
      },
    ],
  },
];

const Features = () => (
  <MarketingPage>
    <PageHero
      eyebrow="PLATFORM CAPABILITIES"
      title="Everything to put an agent"
      highlight="on the phone"
      description="Build the agent, give it a number, let it call, and review every conversation. It all happens in one dashboard, billed by the minute."
    >
      <div className="flex flex-wrap justify-center gap-2">
        {groups.map((g) => (
          <a
            key={g.id}
            href={`#${g.id}`}
            className="px-4 py-2 rounded-full text-sm font-medium bg-secondary text-secondary-foreground border border-border hover:border-primary/40 hover:text-foreground transition-colors"
          >
            {g.eyebrow.split("· ")[1]}
          </a>
        ))}
      </div>
    </PageHero>

    <div className="container mx-auto px-4">
      <StatStrip
        stats={[
          { value: String(VOICE_COUNT), label: "Production voices" },
          { value: String(LANGUAGE_OPTIONS.length), label: "Language modes" },
          { value: String(INDUSTRY_COUNT), label: "Industries" },
          { value: "24/7", label: "Inbound answering" },
        ]}
      />
    </div>

    {groups.map((g, gi) => (
      <Section
        key={g.id}
        id={g.id}
        eyebrow={g.eyebrow}
        title={g.title}
        highlight={g.highlight}
        description={g.description}
        className={gi % 2 === 1 ? "bg-secondary/20" : ""}
      >
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {g.features.map((f) => (
            <IconCard key={f.title} {...f} />
          ))}
        </div>
      </Section>
    ))}

    <CtaBanner />
  </MarketingPage>
);

export default Features;
