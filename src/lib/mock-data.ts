// Centralized mock data for the EDM Nexus dashboard demo.

export type Status = "Active" | "Inactive" | "Paused" | "Error" | "Pending";

export const currentUser = {
  name: "Qarib Morgan",
  email: "qarib@edmnexus.io",
  avatar: "QM",
  role: "Admin",
};

export const setupChecklist = [
  { id: 1, title: "Create your first AI Agent", description: "Configure an agent for lead qualification", time: "5 min", completed: true, icon: "Bot" },
  { id: 2, title: "Get a phone number", description: "Provision a number for inbound or outbound calls", time: "2 min", completed: true, icon: "Phone" },
  { id: 3, title: "Launch your first campaign", description: "Start a dialer campaign with your agent", time: "10 min", completed: true, icon: "Rocket" },
  { id: 4, title: "Integrate to your systems", description: "Connect CRM, telephony, and data sources", time: "8 min", completed: false, icon: "Plug" },
  { id: 5, title: "Set your first automation flow", description: "Build a no-code automation workflow", time: "12 min", completed: false, icon: "Workflow" },
  { id: 6, title: "Review your analytics", description: "Track KPIs across channels and campaigns", time: "3 min", completed: false, icon: "BarChart3" },
];

export const aiAgents = [
  { id: "ag_01", name: "Lia Lead Qualifier", status: "Active", category: "Lead Qualifying", voice: "Aria", language: "English (US)", createdBy: "Qarib Morgan", createdAt: "2025-03-12" },
  { id: "ag_02", name: "Marco Verifier", status: "Active", category: "Lead Verification", voice: "Marco", language: "Spanish (ES)", createdBy: "Qarib Morgan", createdAt: "2025-03-18" },
  { id: "ag_03", name: "Nora Appointment Setter", status: "Inactive", category: "Appointment Setting", voice: "Nora", language: "English (UK)", createdBy: "Sara Lee", createdAt: "2025-02-21" },
  { id: "ag_04", name: "Kai Support Concierge", status: "Active", category: "Customer Support", voice: "Kai", language: "English (US)", createdBy: "Qarib Morgan", createdAt: "2025-04-01" },
  { id: "ag_05", name: "Eva Re-engagement", status: "Active", category: "Re-engagement", voice: "Eva", language: "French (FR)", createdBy: "Diego R.", createdAt: "2025-04-09" },
  { id: "ag_06", name: "Tom Survey Bot", status: "Inactive", category: "Surveys", voice: "Tom", language: "English (US)", createdBy: "Sara Lee", createdAt: "2025-01-30" },
] as const;

export const tools = [
  { id: 1, name: "Send Email", description: "Send transactional emails via SMTP", status: "Active", lastModified: "2025-04-14" },
  { id: 2, name: "Book Calendar Slot", description: "Create a meeting via Calendar API", status: "Active", lastModified: "2025-04-12" },
  { id: 3, name: "Update CRM", description: "Push contact updates to HubSpot", status: "Active", lastModified: "2025-04-10" },
  { id: 4, name: "Send SMS", description: "Send SMS via Twilio", status: "Inactive", lastModified: "2025-03-28" },
  { id: 5, name: "Webhook Trigger", description: "POST event payload to remote URL", status: "Active", lastModified: "2025-03-22" },
];

export const voices = [
  { id: 1, name: "Aria", language: "English (US)", accent: "American", gender: "Female", favorite: true },
  { id: 2, name: "Marco", language: "Spanish (ES)", accent: "Castilian", gender: "Male", favorite: false },
  { id: 3, name: "Nora", language: "English (UK)", accent: "British", gender: "Female", favorite: true },
  { id: 4, name: "Kai", language: "English (US)", accent: "American", gender: "Male", favorite: false },
  { id: 5, name: "Eva", language: "French (FR)", accent: "Parisian", gender: "Female", favorite: true },
  { id: 6, name: "Tom", language: "English (AU)", accent: "Australian", gender: "Male", favorite: false },
  { id: 7, name: "Lia", language: "Italian (IT)", accent: "Roman", gender: "Female", favorite: false },
  { id: 8, name: "Diego", language: "Spanish (MX)", accent: "Latin", gender: "Male", favorite: true },
];

export const integrations = {
  voice: [
    { id: 1, name: "IDT International", description: "Global outbound voice carrier", status: "Active" },
    { id: 2, name: "Outbound IDT (SIP Trunk)", description: "Dedicated outbound SIP trunk", status: "Active" },
    { id: 3, name: "Telico (SIP Trunk)", description: "European SIP gateway", status: "Paused" },
    { id: 4, name: "IDT (SIP Trunk)", description: "Backup SIP trunk", status: "Inactive" },
  ],
  email: [
    { id: 5, name: "SendGrid", description: "Transactional email provider", status: "Active" },
    { id: 6, name: "Mailgun", description: "Email API service", status: "Inactive" },
  ],
};

export const contacts = Array.from({ length: 24 }).map((_, i) => ({
  id: `c_${i + 1}`,
  name: ["Olivia Bennett", "Liam Carter", "Emma Davies", "Noah Hughes", "Ava Patel", "Mia Rossi", "Lucas Müller", "Sofia Garcia"][i % 8] + ` ${i + 1}`,
  phone: `+1 415 555 ${1000 + i}`,
  email: `contact${i + 1}@example.com`,
  status: (["Active", "Inactive", "Pending"] as const)[i % 3],
  list: ["VIP", "Cold Outreach", "Newsletter", "Webinar"][i % 4],
  createdAt: `2025-0${(i % 4) + 1}-${(i % 28) + 1}`,
}));

export const lists = [
  { id: 1, name: "VIP", count: 128, createdAt: "2025-02-10" },
  { id: 2, name: "Cold Outreach Q2", count: 1240, createdAt: "2025-03-04" },
  { id: 3, name: "Newsletter Subscribers", count: 5430, createdAt: "2025-01-22" },
  { id: 4, name: "Webinar Apr 2025", count: 312, createdAt: "2025-04-01" },
];

export const customFields = [
  { id: 1, name: "Company Size", type: "Number" },
  { id: 2, name: "Lifecycle Stage", type: "Dropdown" },
  { id: 3, name: "Last Touch Channel", type: "Text" },
  { id: 4, name: "Lead Score", type: "Number" },
];

export const flows = [
  { id: "fl_001", uuid: "9c2-aa1", name: "Lead Welcome Flow", description: "Welcome new leads via call + email", status: "Active", modifiedAt: "2025-04-15" },
  { id: "fl_002", uuid: "9c2-aa2", name: "Re-engagement", description: "Reach cold contacts after 30 days", status: "Inactive", modifiedAt: "2025-04-10" },
  { id: "fl_003", uuid: "9c2-aa3", name: "Appointment Reminder", description: "SMS + voice 24h before meeting", status: "Active", modifiedAt: "2025-04-12" },
  { id: "fl_004", uuid: "9c2-aa4", name: "Survey After Call", description: "Send a survey post-call", status: "Paused", modifiedAt: "2025-04-08" },
];

export const outboundCampaigns = [
  { id: 1, name: "Q2 SaaS Outreach", status: "Active", agent: "Lia", contacts: 1240, completed: 412 },
  { id: 2, name: "Webinar Follow-up", status: "Paused", agent: "Marco", contacts: 312, completed: 198 },
  { id: 3, name: "Renewal Reminders", status: "Active", agent: "Nora", contacts: 580, completed: 320 },
];

export const inboundQueues = [
  { id: 1, name: "Sales Queue", status: "Active", agent: "Kai", waiting: 3, avgWait: "0:42" },
  { id: 2, name: "Support Queue", status: "Active", agent: "Eva", waiting: 1, avgWait: "0:18" },
  { id: 3, name: "Billing Queue", status: "Inactive", agent: "Tom", waiting: 0, avgWait: " " },
];

export const phoneNumbers = [
  { id: 1, number: "+1 415 555 0100", status: "Active", agent: "Lia", type: "Local" },
  { id: 2, number: "+1 800 555 0144", status: "Active", agent: "Kai", type: "Toll-Free" },
  { id: 3, number: "+44 20 4525 0900", status: "Inactive", agent: "Nora", type: "Local" },
];

export const voiceWidgets = [
  { id: 1, name: "Pricing Page Widget", status: "Active", agent: "Lia", position: "Bottom Right" },
  { id: 2, name: "Docs Helper", status: "Active", agent: "Kai", position: "Bottom Right" },
  { id: 3, name: "Demo Booking", status: "Active", agent: "Marco", position: "Bottom Left" },
];

export const conversations = Array.from({ length: 14 }).map((_, i) => {
  const statuses = ["Initiated", "Queued", "Ringing", "In Progress", "Completed", "Unsuccessful"] as const;
  const channels = ["Voice", "WhatsApp", "SMS", "Web"] as const;
  return {
    id: `cv_${i + 1}`,
    channel: channels[i % channels.length],
    contact: ["Olivia B.", "Liam C.", "Emma D.", "Noah H.", "Ava P.", "Mia R."][i % 6],
    phone: `+1 415 555 ${2000 + i}`,
    duration: `${Math.floor(((i * 37) % 5))}:${String((i * 13) % 60).padStart(2, "0")}`,
    status: statuses[i % statuses.length],
    conversion: i % 3 === 0 ? "Yes" : "No",
    recording: i % 2 === 0,
    warmTransfer: i % 4 === 0,
    callTime: `2025-04-${(i % 16) + 1} 14:${String(10 + i).padStart(2, "0")}`,
  };
});

export const conversationStats = [
  { label: "Total", count: 1240, color: "muted" },
  { label: "Initiated", count: 320, color: "info" },
  { label: "Queued", count: 48, color: "muted" },
  { label: "Ringing", count: 22, color: "warning" },
  { label: "In Progress", count: 64, color: "info" },
  { label: "Unsuccessful", count: 96, color: "destructive" },
  { label: "Completed", count: 690, color: "success" },
];

export const analyticsTimeSeries = Array.from({ length: 14 }).map((_, i) => ({
  day: `D${i + 1}`,
  calls: 80 + ((i * 47) % 120),
  conversions: 20 + ((i * 23) % 60),
  duration: 60 + ((i * 31) % 120),
}));

export const teamMembers = [
  { id: 1, name: "Qarib Morgan", email: "qarib@edmnexus.io", role: "Admin", status: "Active" },
  { id: 2, name: "Sara Lee", email: "sara@edmnexus.io", role: "Manager", status: "Active" },
  { id: 3, name: "Diego R.", email: "diego@edmnexus.io", role: "Editor", status: "Active" },
  { id: 4, name: "Priya N.", email: "priya@edmnexus.io", role: "Viewer", status: "Inactive" },
];

export const faqs = [
  { q: "How do I create my first AI agent?", a: "Go to AI Agents and click + Add New Agent. Choose a template, voice, language, and goal." },
  { q: "Can I bring my own SIP trunk?", a: "Yes under Integrations → Voice & Telephony you can connect any compatible SIP trunk." },
  { q: "How does pricing work?", a: "We bill monthly per active agent and per voice minute. See the pricing page for details." },
  { q: "Is my data secure?", a: "All data is encrypted in transit and at rest. We're SOC 2 Type II certified." },
  { q: "Can I export conversation data?", a: "Yes, every report can be exported to CSV or pushed to Google Sheets in real time." },
];
