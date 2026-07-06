import { Globe, Zap, Clock, Languages } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const stats = [
  { label: "Always On", value: "24/7/365", icon: Clock },
  { label: "Languages", value: "29+", icon: Languages },
  { label: "Scalability", value: "∞", icon: Zap },
  { label: "Response Time", value: "<1s", icon: Globe },
];

const agents = [
  { name: "Sofia", flag: "🇺🇸", task: "closing a sale in Bengali", time: "01:15 UTC" },
  { name: "Maya", flag: "🇩🇪", task: "onboarding client in German", time: "09:30 UTC" },
  { name: "Alex", flag: "🇵🇹", task: "sending loyalty rewards in Greek", time: "12:45 UTC" },
  { name: "Jordan", flag: "🇸🇦", task: "handling support in Arabic", time: "15:20 UTC" },
  { name: "Taylor", flag: "🇰🇷", task: "scheduling appointments in Korean", time: "22:10 UTC" },
];

const languages = [
  "🇺🇸 English", "🇨🇳 Chinese", "🇫🇷 French", "🇩🇪 German", "🇮🇳 Hindi",
  "🇮🇹 Italian", "🇵🇹 Portuguese", "🇪🇸 Spanish", "🇹🇭 Thai", "🇸🇦 Arabic",
  "🇷🇺 Russian", "🇯🇵 Japanese", "🇰🇷 Korean", "🇻🇳 Vietnamese", "🇮🇩 Indonesian",
  "🇹🇷 Turkish", "🇳🇱 Dutch", "🇵🇱 Polish", "🇸🇪 Swedish", "🇩🇰 Danish",
  "🇫🇮 Finnish", "🇳🇴 Norwegian", "🇬🇷 Greek", "🇨🇿 Czech", "🇭🇺 Hungarian",
  "🇷🇴 Romanian", "🇮🇱 Hebrew", "🇧🇩 Bengali", "🇲🇾 Malay",
];

const AIWorkforce = () => (
  <section id="technology" className="py-24 relative">
    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full bg-primary/3 blur-[150px] pointer-events-none" />
    <div className="container mx-auto px-4 relative z-10">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">AI Powered Workforce</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          AI ELASTIC <span className="text-gradient">TASK FORCE</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-2xl mx-auto">
          Your 24/7 global workforce that speaks every language, handles every task, and scales infinitely.
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
        {stats.map((s) => (
          <div key={s.label} className="surface-card p-5 text-center">
            <s.icon size={20} className="text-primary mx-auto mb-2" />
            <div className="text-2xl font-black text-gradient">{s.value}</div>
            <div className="text-xs text-muted-foreground mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Agent feed */}
      <div className="grid lg:grid-cols-2 gap-6 mb-12">
        <div className="surface-card p-6">
          <h3 className="text-lg font-bold mb-4 text-foreground">Command Hub</h3>
          <div className="space-y-3">
            {agents.map((a) => (
              <div key={a.name} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50">
                <span className="text-2xl">{a.flag}</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-foreground">{a.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{a.task}</div>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{a.time}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="surface-card p-6">
          <h3 className="text-lg font-bold mb-4 text-foreground">Global Language Coverage</h3>
          <div className="flex flex-wrap gap-2">
            {languages.map((lang) => (
              <span key={lang} className="px-3 py-1.5 rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                {lang}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="text-center">
        <Link to="/request-access">
          <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2">
            Deploy Your AI Workforce
          </Button>
        </Link>
      </div>
    </div>
  </section>
);

export default AIWorkforce;
