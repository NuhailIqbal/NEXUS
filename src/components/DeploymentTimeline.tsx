import { UserPlus, Bot, Phone, Rocket, BarChart3 } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

// The real self-serve path through the product — no sales call, no onboarding project.
const steps = [
  {
    step: "Step 1",
    title: "Create your account",
    desc: "Sign up and confirm your email. We drop $20 of free credit into your balance so you can test properly before spending anything.",
    icon: UserPlus,
  },
  {
    step: "Step 2",
    title: "Build your agent",
    desc: "A guided setup asks what the agent should achieve, which industry it's for, and which voice to use. Upload a document or paste your FAQs as its knowledge.",
    icon: Bot,
  },
  {
    step: "Step 3",
    title: "Get a phone number",
    desc: "Provision a number in the area code you want, then assign your agent to it. $3 per month, charged from your balance.",
    icon: Phone,
  },
  {
    step: "Step 4",
    title: "Go live",
    desc: "For outbound, point the agent at a contact list and launch a campaign. For inbound, it simply starts answering — including outside business hours.",
    icon: Rocket,
  },
  {
    step: "Step 5",
    title: "Review every call",
    desc: "Listen to the recording, read the transcript, check the AI summary, and see exactly what that call cost you.",
    icon: BarChart3,
  },
];

const DeploymentTimeline = () => (
  <section className="py-24">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">GETTING STARTED</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          From sign-up to your <span className="text-gradient">first call</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          It's self-serve — you don't need a sales call or an onboarding project to get an agent
          on the phone.
        </p>
      </div>

      <div className="relative max-w-4xl mx-auto">
        {/* Vertical line */}
        <div className="hidden md:block absolute left-8 top-0 bottom-0 w-px bg-gradient-to-b from-primary/50 via-primary/20 to-transparent" />

        <div className="space-y-8">
          {steps.map((step) => (
            <div key={step.title} className="flex gap-6 items-start group">
              <div className="hidden md:flex flex-col items-center">
                <div className="w-16 h-16 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                  <step.icon size={24} className="text-primary" />
                </div>
              </div>
              <div className="surface-card p-6 flex-1">
                <span className="text-xs font-bold text-primary uppercase tracking-wider">{step.step}</span>
                <h3 className="text-lg font-bold text-foreground mt-1">{step.title}</h3>
                <p className="text-sm text-muted-foreground mt-2">{step.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Honest headline facts about getting started */}
      <div className="grid grid-cols-3 gap-6 max-w-xl mx-auto mt-16 text-center">
        <div>
          <div className="stat-number">$20</div>
          <div className="text-xs text-muted-foreground mt-1">Free credit to start</div>
        </div>
        <div>
          <div className="stat-number">5</div>
          <div className="text-xs text-muted-foreground mt-1">Steps to your first call</div>
        </div>
        <div>
          <div className="stat-number">$0</div>
          <div className="text-xs text-muted-foreground mt-1">Monthly platform fee</div>
        </div>
      </div>

      <div className="text-center mt-12">
        <Link to="/register">
          <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8">
            Create your account
          </Button>
        </Link>
      </div>
    </div>
  </section>
);

export default DeploymentTimeline;
