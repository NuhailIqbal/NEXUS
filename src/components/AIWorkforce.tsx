import { Mic, Languages, Clock, FileAudio } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const stats = [
  { label: "Built-in voices", value: "13", icon: Mic },
  { label: "Languages", value: "5", icon: Languages },
  { label: "Always answering", value: "24/7", icon: Clock },
  { label: "Call recorded", value: "Every", icon: FileAudio },
];

// The actual voice roster available when you build an agent — same names and
// characteristics you'll see in the AI Voices page of the dashboard.
const voices = [
  { name: "Elliot", accent: "Canadian", note: "Friendly, professional" },
  { name: "Savannah", accent: "American (Southern)", note: "Warm, straightforward" },
  { name: "Clara", accent: "American", note: "Warm, professional" },
  { name: "Kai", accent: "American", note: "Friendly, relaxed" },
  { name: "Layla", accent: "American", note: "Bright, cheerful" },
  { name: "Nico", accent: "American", note: "Young, casual" },
  { name: "Sid", accent: "American", note: "Laid-back, deep-toned" },
  { name: "Godfrey", accent: "American", note: "Young, energetic" },
  { name: "Emma", accent: "Asian American", note: "Warm, conversational" },
  { name: "Rohan", accent: "Indian American", note: "Bright, energetic" },
  { name: "Sagar", accent: "Indian American", note: "Steady, professional" },
  { name: "Neil", accent: "Indian American", note: "Clear, professional" },
  { name: "Naina", accent: "Indian American", note: "Calm, collected" },
];

const languages = ["🇺🇸 English (US)", "🇬🇧 English (UK)", "🇪🇸 Spanish", "🇫🇷 French", "🇩🇪 German", "🇮🇹 Italian"];

const included = [
  "Call recording on every call",
  "Speaker-labelled transcript",
  "AI summary of what was said",
  "Transfer to a human mid-call",
];

const AIWorkforce = () => (
  <section id="technology" className="py-24 relative">
    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full bg-primary/3 blur-[150px] pointer-events-none" />
    <div className="container mx-auto px-4 relative z-10">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">Voices &amp; Languages</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          Pick a voice that <span className="text-gradient">sounds human</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-2xl mx-auto">
          Thirteen production voices across American, Canadian and Indian-American accents. Preview
          any of them in the dashboard before you assign one to an agent.
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

      <div className="grid lg:grid-cols-2 gap-6 mb-12">
        {/* Real voice roster */}
        <div className="surface-card p-6">
          <h3 className="text-lg font-bold mb-4 text-foreground">Voice roster</h3>
          <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
            {voices.map((v) => (
              <div key={v.name} className="flex items-center gap-3 p-3 rounded-lg bg-secondary/50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <Mic size={14} className="text-primary" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-foreground">{v.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{v.note}</div>
                </div>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{v.accent}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-6">
          <div className="surface-card p-6">
            <h3 className="text-lg font-bold mb-4 text-foreground">Languages</h3>
            <div className="flex flex-wrap gap-2">
              {languages.map((lang) => (
                <span key={lang} className="px-3 py-1.5 rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                  {lang}
                </span>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Set per agent: the transcriber and voice both follow the language you choose.
            </p>
          </div>

          <div className="surface-card p-6 flex-1">
            <h3 className="text-lg font-bold mb-4 text-foreground">Included on every agent</h3>
            <ul className="space-y-2.5">
              {included.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-foreground">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <div className="text-center">
        <Link to="/register">
          <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2">
            Create your first agent
          </Button>
        </Link>
      </div>
    </div>
  </section>
);

export default AIWorkforce;
