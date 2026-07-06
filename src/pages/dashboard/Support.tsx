import { LifeBuoy, MessageSquare, Mail } from "lucide-react";
const faqs = [
  { q: "How do I create my first AI agent?", a: "Go to AI Agents and click + Add New Agent. Choose a template, voice, language, and goal." },
  { q: "Can I bring my own SIP trunk?", a: "Yes under Integrations > Voice & Telephony you can connect any compatible SIP trunk." },
  { q: "How does pricing work?", a: "We bill monthly per active agent and per voice minute. See the pricing page for details." },
  { q: "Is my data secure?", a: "All data is encrypted in transit and at rest. We're SOC 2 Type II certified." },
  { q: "Can I export conversation data?", a: "Yes, every report can be exported to CSV or pushed to Google Sheets in real time." },
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
        { icon: Mail, label: "Email", desc: "support@edmnexus.ai" },
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
