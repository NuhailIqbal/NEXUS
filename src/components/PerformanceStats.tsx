import { UserCheck, CalendarCheck, MoonStar, Repeat, Headphones, PackageCheck } from "lucide-react";

// Concrete setups you can actually build today. The tag says WHICH part of the product
// each one uses — no outcome or performance claims.
const useCases = [
  {
    icon: UserCheck,
    title: "Lead qualification",
    desc: "Call new enquiries, ask your qualifying questions, and transfer the promising ones to a salesperson while they're still on the line.",
    tag: "Outbound campaign + live transfer",
  },
  {
    icon: MoonStar,
    title: "After-hours reception",
    desc: "Let an agent answer when your office is closed, so evening and weekend callers get a real conversation instead of voicemail.",
    tag: "Inbound agent on your number",
  },
  {
    icon: CalendarCheck,
    title: "Appointment reminders",
    desc: "Ring through a list of upcoming bookings to confirm, reschedule, or flag the no-shows before they happen.",
    tag: "Outbound campaign + contact list",
  },
  {
    icon: Repeat,
    title: "Re-engaging old leads",
    desc: "Work back through a list that went cold and find out who's still interested, without tying up your team for days.",
    tag: "Outbound campaign",
  },
  {
    icon: Headphones,
    title: "Support triage",
    desc: "Answer the questions that come up constantly using an uploaded knowledge base, and pass anything unusual to a human.",
    tag: "Inbound agent + knowledge upload",
  },
  {
    icon: PackageCheck,
    title: "Status and follow-up calls",
    desc: "Place routine update calls — order status, document chasing, post-service check-ins — and keep a transcript of each one.",
    tag: "Outbound campaign + transcripts",
  },
];

const PerformanceStats = () => (
  <section className="py-24">
    <div className="container mx-auto px-4">
      <div className="text-center mb-16">
        <h2 className="text-3xl md:text-5xl font-bold">
          What people <span className="text-gradient">build with it</span>
        </h2>
        <p className="text-muted-foreground mt-4 max-w-xl mx-auto">
          Every setup below is the same three ingredients — an agent, a phone number, and
          optionally a contact list.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
        {useCases.map((u) => (
          <div key={u.title} className="surface-card p-6 flex flex-col gap-3">
            <u.icon size={20} className="text-primary" />
            <h3 className="text-lg font-bold text-foreground">{u.title}</h3>
            <p className="text-sm text-muted-foreground">{u.desc}</p>
            <div className="mt-auto pt-3 border-t border-border">
              <span className="text-xs font-medium text-primary">{u.tag}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default PerformanceStats;
