import { LifeBuoy, MessageSquare, Mail } from "lucide-react";
const faqs = [
  { q: "How do I create my first AI agent?", a: "Go to AI Agents and click + Create Agent. Pick a voice, language, and category, write a system prompt and first message, then save — your agent syncs to Vapi automatically and is ready to take or make calls." },
  { q: "How do I get a phone number?", a: "Go to Outbound > Phone Numbers and click Buy a Number. Choose an area code, complete checkout, and the number is provisioned to your account and ready to assign to an agent for inbound or outbound calling." },
  { q: "How does billing work?", a: "Nexus is pay-as-you-go — no subscription. Calls are billed per minute at the rate shown on your Billing page, deducted from your credit balance. Add funds manually or turn on auto recharge so you're never interrupted mid-campaign." },
  { q: "How do I import my contacts?", a: "Go to Database > Contacts and click Import CSV, or add contacts one by one. Organize them into Lists so you can target a specific group when launching an outbound campaign." },
  { q: "How do outbound campaigns work?", a: "Under Outbound > Campaigns, create a campaign by picking an agent, a contact list, and a phone number to call from. Start, pause, or resume it anytime, and track qualified leads and completed calls as it runs." },
  { q: "Can an agent answer incoming calls?", a: "Yes — set up an AI Receptionist under Inbound to route incoming calls to an agent, and review every call afterward in Inbound > Call Logs." },
  { q: "Where can I listen to call recordings and transcripts?", a: "Open All Conversations and click any call to view its recording, full transcript, and AI-generated summary." },
  { q: "Is my data secure?", a: "Data is encrypted in transit, access to your account is protected by your login, and card details are handled by Stripe — they never touch our servers." },
];
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

const Support = () => (
  <div className="space-y-8">
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">Support</h1>
      <p className="text-sm text-muted-foreground">Find answers fast or get in touch with our team.</p>
    </div>

    <div className="grid gap-4 md:grid-cols-3">
      {[
        { icon: LifeBuoy, label: "Help Center", desc: "Articles & guides" },
        { icon: MessageSquare, label: "Live Chat", desc: "Mon–Fri, 9–6 ET" },
        { icon: Mail, label: "Email", desc: "edmnexusai@gmail.com" },
      ].map((c) => (
        <div key={c.label} className="rounded-xl border border-border bg-card p-5 card-interactive">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <c.icon className="h-5 w-5" />
          </div>
          <h3 className="mt-4 font-semibold text-foreground">{c.label}</h3>
          <p className="text-xs text-muted-foreground">{c.desc}</p>
        </div>
      ))}
    </div>

    <section>
      <h2 className="mb-3 font-semibold text-foreground">Frequently asked questions</h2>
      <Accordion type="single" collapsible className="rounded-xl border border-border bg-card px-4">
        {faqs.map((f, i) => (
          <AccordionItem key={i} value={`f${i}`}>
            <AccordionTrigger className="text-left">{f.q}</AccordionTrigger>
            <AccordionContent>{f.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  </div>
);

export default Support;
