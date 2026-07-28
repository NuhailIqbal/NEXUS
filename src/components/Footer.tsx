import { Mail } from "lucide-react";
import { Link } from "react-router-dom";
import Logo from "@/components/Logo";

const platformLinks: { label: string; to: string }[] = [
  { label: "AI Voice Agents", to: "/features" },
  { label: "Outbound Campaigns", to: "/use-cases" },
  { label: "AI Receptionist", to: "/use-cases" },
  { label: "Recordings & Transcripts", to: "/features" },
  { label: "Technology", to: "/technology" },
  { label: "White-Label", to: "/publishers" },
];

const companyLinks: { label: string; to: string }[] = [
  { label: "About", to: "/about" },
  { label: "Pricing", to: "/pricing" },
  { label: "Contact", to: "/request-access" },
  { label: "Advertisers", to: "/advertisers" },
  { label: "Publishers", to: "/publishers" },
];

// Only list documents that actually exist — a named legal link that quietly lands on
// another page is worse than no link. Add Terms of Service here once it's written.
const legalLinks: { label: string; to: string }[] = [
  { label: "Privacy Policy", to: "/privacy" },
];

const Footer = () => (
  <footer className="border-t border-border py-16">
    <div className="container mx-auto px-4">
      <div className="grid md:grid-cols-4 gap-10">
        <div>
          <div className="mb-4">
            <Logo linked={false} />
          </div>
          <p className="text-sm text-muted-foreground">
            AI voice agents that make and answer your calls, billed by the minute.
          </p>
        </div>

        <div>
          <h4 className="text-sm font-bold text-foreground mb-4">Platform</h4>
          <div className="space-y-2">
            {platformLinks.map((item) => (
              <Link key={item.label} to={item.to} className="block text-sm text-muted-foreground hover:text-foreground transition-colors">
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-sm font-bold text-foreground mb-4">Company</h4>
          <div className="space-y-2">
            {companyLinks.map((item) => (
              <Link key={item.label} to={item.to} className="block text-sm text-muted-foreground hover:text-foreground transition-colors">
                {item.label}
              </Link>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-sm font-bold text-foreground mb-4">Contact</h4>
          <div className="space-y-3">
            <a href="mailto:info@edmnexus.ai" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <Mail size={14} className="text-primary" /> info@edmnexus.ai
            </a>
          </div>
        </div>
      </div>

      <div className="border-t border-border mt-12 pt-6 flex flex-col md:flex-row items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">© {new Date().getFullYear()} EDM Nexus. All rights reserved.</p>
        <div className="flex gap-6">
          {legalLinks.map((item) => (
            <Link key={item.label} to={item.to} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              {item.label}
            </Link>
          ))}
        </div>
      </div>
    </div>
  </footer>
);

export default Footer;
