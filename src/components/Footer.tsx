import { Phone, Mail } from "lucide-react";
import { Link } from "react-router-dom";
import Logo from "@/components/Logo";

const platformLinks: { label: string; to: string }[] = [
  { label: "Acquisition Engine", to: "/features" },
  { label: "Brand Studio", to: "/features" },
  { label: "Operations OS", to: "/technology" },
  { label: "AI Workforce", to: "/technology" },
  { label: "Omni-Channel", to: "/use-cases" },
  { label: "White-Label", to: "/publishers" },
];

const companyLinks: { label: string; to: string }[] = [
  { label: "About", to: "/about" },
  { label: "Pricing", to: "/pricing" },
  { label: "Contact", to: "/request-access" },
  { label: "Advertisers", to: "/advertisers" },
  { label: "Publishers", to: "/publishers" },
];

const legalLinks: { label: string; to: string }[] = [
  { label: "Privacy Policy", to: "/about" },
  { label: "Terms of Service", to: "/about" },
  { label: "Cookie Policy", to: "/about" },
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
            AI powered revenue infrastructure for inbound acquisition at scale.
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
            <a href="tel:+18337118975" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <Phone size={14} className="text-primary" /> (833) 711-8975
            </a>
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
