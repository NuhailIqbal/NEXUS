import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Mic, Ear, MessageSquare, FileAudio, Lock, Wallet, PhoneCall, Cpu, Activity } from "lucide-react";

const techStack = [
  { icon: Ear, label: "Speech Recognition", desc: "Call audio is transcribed to text in real time as the conversation happens" },
  { icon: MessageSquare, label: "Conversational AI", desc: "A language model drives the agent's side of the conversation, guided by the instructions and knowledge you give it" },
  { icon: Mic, label: "Natural Voice Output", desc: "Text responses are converted back to speech using one of 13 production voices" },
  { icon: FileAudio, label: "Recording & Transcription", desc: "Every call is recorded and transcribed automatically, with an AI summary generated afterward" },
  { icon: Lock, label: "Security", desc: "Encrypted in transit, per-account access control, and payment card details handled entirely by our payment processor" },
  { icon: Wallet, label: "Usage-Based Billing", desc: "Each call's actual cost is calculated and deducted from your balance individually" },
];

const pipeline = [
  {
    icon: PhoneCall,
    title: "The call connects",
    desc: "A phone number rings in, or an outbound call is placed to a contact from your list.",
  },
  {
    icon: Cpu,
    title: "The agent listens and responds",
    desc: "Speech is transcribed, the agent decides what to say using its configured goal and knowledge, and a voice speaks the reply — in a continuous back-and-forth for the length of the call.",
  },
  {
    icon: Activity,
    title: "The call is wrapped up",
    desc: "Once the call ends, the recording, transcript, and summary are generated and the exact cost of that call is calculated and charged to your balance.",
  },
];

const facts = [
  { value: "13", label: "Production Voices" },
  { value: "5", label: "Languages Supported" },
  { value: "Every", label: "Call Recorded" },
  { value: "24/7", label: "Inbound Availability" },
];

const Technology = () => (
  <div className="min-h-screen bg-background">
    <Navbar />
    <section className="relative pt-32 pb-20 overflow-hidden">
      <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
      <div className="absolute top-1/4 right-1/4 w-[500px] h-[500px] rounded-full bg-accent/5 blur-[150px] pointer-events-none" />

      <div className="container mx-auto px-4 relative z-10">
        <div className="text-center mb-16">
          <div className="badge-pill mx-auto mb-6 animate-slide-up">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
            HOW IT WORKS
          </div>
          <h1 className="text-4xl md:text-6xl font-black mb-4 animate-slide-up" style={{ animationDelay: "0.1s" }}>
            What happens on <span className="text-gradient">every call</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
            A plain look at the pipeline behind each call your agent makes or answers.
          </p>
        </div>

        {/* Pipeline */}
        <div className="glow-border rounded-2xl p-8 mb-16 animate-slide-up" style={{ animationDelay: "0.3s" }}>
          <div className="grid md:grid-cols-3 gap-8">
            {pipeline.map((step) => (
              <div key={step.title} className="text-center">
                <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4">
                  <step.icon size={28} className="text-primary" />
                </div>
                <h3 className="text-lg font-bold text-foreground mb-2">{step.title}</h3>
                <p className="text-sm text-muted-foreground">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Tech Stack */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
          {techStack.map((t, i) => (
            <div key={t.label} className="surface-card p-6 animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                <t.icon size={20} className="text-primary" />
              </div>
              <h3 className="font-bold text-foreground mb-1">{t.label}</h3>
              <p className="text-sm text-muted-foreground">{t.desc}</p>
            </div>
          ))}
        </div>

        {/* Facts */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {facts.map((f, i) => (
            <div key={f.label} className="text-center p-4 rounded-xl border border-border bg-card animate-slide-up" style={{ animationDelay: `${0.05 * i}s` }}>
              <div className="text-2xl font-black text-gradient mb-1">{f.value}</div>
              <div className="text-xs text-muted-foreground">{f.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
    <Footer />
  </div>
);

export default Technology;
