import { Check, Gift, Phone, Wallet, RefreshCw, Ticket, X } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  MarketingPage,
  PageHero,
  Section,
  CtaBanner,
  PrimaryCta,
} from "@/components/marketing/MarketingPrimitives";
import {
  VOICE_COUNT,
  LANGUAGE_OPTIONS,
  TYPICAL_RATE_PER_MINUTE,
  PHONE_NUMBER_MONTHLY,
  SIGNUP_CREDIT,
  SIGNUP_CREDIT_EXPIRY_DAYS,
  TOP_UP_MIN,
  TOP_UP_MAX,
} from "@/lib/marketing-facts";

const included = [
  "Unlimited AI agents",
  `${VOICE_COUNT} production voices, English, Urdu & multilingual`,
  "Outbound campaigns with CSV import and DNC screening",
  "24/7 AI receptionist for inbound calls",
  "Recording, transcript and AI summary on every call",
  "Live transfer to your team",
  "Post-call automation: SMS, call-backs, webhooks",
  "Analytics, team roles and unlimited teammates",
];

const extras = [
  {
    icon: Phone,
    title: "Phone numbers",
    value: `${PHONE_NUMBER_MONTHLY}/mo`,
    desc: "Per US local number, renewed monthly from your balance.",
  },
  {
    icon: Wallet,
    title: "Add funds",
    value: `${TOP_UP_MIN}–${TOP_UP_MAX}`,
    desc: "Top up by card whenever you like, straight from the dashboard.",
  },
  {
    icon: RefreshCw,
    title: "Auto recharge",
    value: "Optional",
    desc: "Pick a threshold and amount, and a saved card tops you up automatically.",
  },
  {
    icon: Ticket,
    title: "Promo codes",
    value: "Redeemable",
    desc: "Have a code? Redeem it from the Billing page for extra credit.",
  },
];

const neverPay = ["Monthly subscription", "Per-seat licenses", "Setup or onboarding fees", "Agents sitting idle", "Annual contracts"];

const example = [
  { label: "Call duration", value: "2 min 30 sec" },
  { label: "Typical rate", value: `~${TYPICAL_RATE_PER_MINUTE} / min` },
  { label: "Charged to balance", value: "~$0.88", strong: true },
];

const faqs = [
  {
    q: "How is the per-minute cost worked out?",
    a: `Each call is charged at its actual cost: the voice AI and phone carrier cost of that specific call, times a flat platform rate. For most calls this comes to about ${TYPICAL_RATE_PER_MINUTE} a minute. The exact charge for every call is itemized on your Billing page under Call Costs.`,
  },
  {
    q: "What do I get when I sign up?",
    a: `Every new account gets ${SIGNUP_CREDIT} of free credit as soon as you verify your email address. It's valid for ${SIGNUP_CREDIT_EXPIRY_DAYS} days and it's spent before any funds you add yourself. No card is needed to sign up.`,
  },
  {
    q: "Do I pay anything when my agents aren't on a call?",
    a: `No. Agents, teammates, analytics and automations cost nothing on their own. The only recurring charge is ${PHONE_NUMBER_MONTHLY} per month for each phone number you keep.`,
  },
  {
    q: "What happens if my balance runs out?",
    a: "You'll get alerts as your balance drops to $10, $5 and $1. At $0, new outbound calls can't start, and your inbound numbers play a short 'temporarily unavailable' message instead of the agent. Everything restores automatically as soon as you top up, and auto recharge prevents it from happening at all.",
  },
  {
    q: "How are phone numbers billed?",
    a: `Each number costs ${PHONE_NUMBER_MONTHLY} a month. The first month is taken from your balance, or through card checkout if your balance is too low, and it renews monthly from your balance after that. Release a number any time to stop paying for it.`,
  },
  {
    q: "Is there a discount for high volume?",
    a: "Yes, we can set a custom rate for accounts running a lot of calls. Get in touch and tell us about your volume.",
  },
];

const Pricing = () => (
  <MarketingPage>
    <PageHero
      eyebrow="PRICING"
      title="One rate."
      highlight="No plans to pick."
      description="Every feature is available to every account from day one. You top up a balance and only pay for the minutes your agents actually spend on calls."
    />

    <section className="pb-8">
      <div className="container mx-auto px-4">
        <div className="grid lg:grid-cols-5 gap-6 max-w-6xl mx-auto">
          {/* Main rate card */}
          <div className="lg:col-span-3 glow-border rounded-2xl p-6 md:p-8 bg-card">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-6">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.2em] text-primary mb-2">Pay as you go</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-5xl md:text-6xl font-black text-gradient">~{TYPICAL_RATE_PER_MINUTE}</span>
                  <span className="text-muted-foreground">/ minute</span>
                </div>
                <p className="text-sm text-muted-foreground mt-2">Billed at each call's actual cost. Connected minutes only.</p>
              </div>
            </div>

            <div className="flex items-center gap-2 mb-6 px-4 py-2.5 rounded-lg bg-primary/10 text-sm text-primary">
              <Gift size={16} className="shrink-0" /> {SIGNUP_CREDIT} free credit when you verify your email
            </div>

            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-3 mb-8">
              {included.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Check size={16} className="text-primary mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>

            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <PrimaryCta />
              <span className="text-xs text-muted-foreground">No card required to sign up.</span>
            </div>
          </div>

          {/* Extras */}
          <div className="lg:col-span-2 grid sm:grid-cols-2 lg:grid-cols-1 gap-4">
            {extras.map((e) => (
              <div key={e.title} className="surface-card p-5 flex items-start gap-4">
                <div className="w-10 h-10 shrink-0 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <e.icon size={18} className="text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-semibold text-foreground">{e.title}</span>
                    <span className="text-sm font-bold text-primary">{e.value}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{e.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>

    <Section eyebrow="No surprises" title="What a call" highlight="actually costs">
      <div className="grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
        <div className="surface-card p-6">
          <h3 className="font-bold text-foreground mb-1">Worked example</h3>
          <p className="text-xs text-muted-foreground mb-4">A typical two-and-a-half minute call.</p>
          <div className="space-y-2">
            {example.map((row) => (
              <div
                key={row.label}
                className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-sm ${
                  row.strong ? "bg-primary/10 font-semibold text-foreground" : "bg-secondary/50 text-muted-foreground"
                }`}
              >
                <span>{row.label}</span>
                <span className={row.strong ? "text-primary" : "text-foreground"}>{row.value}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            The exact figure varies slightly per call, and you can see every charge in Call Costs.
          </p>
        </div>

        <div className="surface-card p-6">
          <h3 className="font-bold text-foreground mb-4">What you'll never pay for</h3>
          <ul className="space-y-3">
            {neverPay.map((n) => (
              <li key={n} className="flex items-center gap-3 text-sm text-foreground">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary">
                  <X size={13} className="text-muted-foreground" />
                </span>
                {n}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground mt-5 pt-4 border-t border-border">
            Supports {LANGUAGE_OPTIONS.length} language modes at the same rate. No premium surcharge for Urdu or multilingual agents.
          </p>
        </div>
      </div>
    </Section>

    <Section eyebrow="FAQ" title="Billing" highlight="questions" className="bg-secondary/20">
      <div className="max-w-3xl mx-auto">
        <Accordion type="single" collapsible className="space-y-3">
          {faqs.map((f, i) => (
            <AccordionItem key={f.q} value={`faq-${i}`} className="rounded-xl border border-border bg-card px-5">
              <AccordionTrigger className="text-left text-sm md:text-base font-semibold hover:no-underline">{f.q}</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground leading-relaxed">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
        <p className="text-sm text-muted-foreground text-center mt-8">
          Running a high volume of calls?{" "}
          <a href="mailto:edmnexusai@gmail.com" className="text-primary hover:underline">Email us</a> about a custom rate.
        </p>
      </div>
    </Section>

    <CtaBanner />
  </MarketingPage>
);

export default Pricing;
