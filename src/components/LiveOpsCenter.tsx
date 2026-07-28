import { FileAudio, FileText, Sparkles, Receipt, PhoneForwarded, Bell } from "lucide-react";

// What the dashboard actually gives you once a call ends. Each item below maps to a
// real field on the conversation record, not a marketing metric.
const afterCall = [
  {
    icon: FileAudio,
    title: "The recording",
    desc: "Play back the full call straight from the conversation list.",
  },
  {
    icon: FileText,
    title: "The transcript",
    desc: "Speaker-labelled, so you can see who said what and when.",
  },
  {
    icon: Sparkles,
    title: "An AI summary",
    desc: "A short write-up of what happened, generated automatically.",
  },
  {
    icon: Receipt,
    title: "What it cost",
    desc: "The duration and the actual charge for that specific call, itemised.",
  },
  {
    icon: PhoneForwarded,
    title: "Transfer outcome",
    desc: "Whether the agent handed the caller off to a human, and to which number.",
  },
  {
    icon: Bell,
    title: "Balance alerts",
    desc: "Get notified as your credit runs low, before calls start failing.",
  },
];

// Illustrative example only. Calls are billed on their ACTUAL cost (the voice + carrier
// cost of that specific call), which works out to roughly $0.35/min — so the exact
// figure varies slightly call to call. Keep this framed as approximate.
const exampleRows = [
  { label: "Call duration", value: "2 min 30 sec" },
  { label: "Typical rate", value: "~$0.35 / min" },
  { label: "Charged to balance", value: "~$0.88", strong: true },
];

const LiveOpsCenter = () => (
  <section className="py-24 relative overflow-hidden">
    <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.02] via-transparent to-transparent pointer-events-none" />
    <div className="container mx-auto px-4 relative z-10">
      <div className="text-center mb-16">
        <span className="badge-pill mb-4">Full Visibility</span>
        <h2 className="text-3xl md:text-5xl font-bold mt-4">
          Know exactly what happened <span className="text-gradient">on every call</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          Nothing is a black box. Each completed call lands in your dashboard with the audio, the
          transcript and its cost attached.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {afterCall.map((item) => (
          <div key={item.title} className="surface-card p-5">
            <item.icon size={18} className="text-primary mb-3" />
            <div className="text-sm font-semibold text-foreground">{item.title}</div>
            <div className="text-xs text-muted-foreground mt-1">{item.desc}</div>
          </div>
        ))}
      </div>

      {/* Worked pricing example */}
      <div className="surface-card p-6 max-w-md mx-auto">
        <h3 className="text-sm font-bold text-foreground mb-1">How a call is billed</h3>
        <p className="text-xs text-muted-foreground mb-4">
          An example, so there are no surprises on your balance.
        </p>
        <div className="space-y-2">
          {exampleRows.map((row) => (
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
        <p className="mt-4 pt-4 border-t border-border text-xs text-muted-foreground">
          You're only charged for connected minutes, and each call is billed at its actual cost — so
          the real figure varies slightly per call. Phone numbers are billed separately at $3 per
          month.
        </p>
      </div>
    </div>
  </section>
);

export default LiveOpsCenter;
