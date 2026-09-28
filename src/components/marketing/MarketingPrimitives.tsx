import { useEffect, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { SIGNUP_CREDIT } from "@/lib/marketing-facts";

// Shared building blocks for the public marketing pages, so every page gets the same
// hero, section rhythm and closing call-to-action.

// Client-side navigation keeps the previous page's scroll position, so a footer link
// would land mid-page. Start each page at the top, or at its #section when linked to one.
const useScrollOnNavigate = () => {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (hash) {
      const el = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (el) {
        el.scrollIntoView();
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [pathname, hash]);
};

export const MarketingPage = ({ children }: { children: ReactNode }) => {
  useScrollOnNavigate();
  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main>{children}</main>
      <Footer />
    </div>
  );
};

export const PageHero = ({
  eyebrow,
  title,
  highlight,
  description,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  highlight: ReactNode;
  description: ReactNode;
  children?: ReactNode;
}) => (
  <section className="relative pt-32 pb-16 md:pb-20 overflow-hidden">
    <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
    <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] max-w-full h-[600px] rounded-full bg-primary/5 blur-[150px] pointer-events-none" />
    <div className="container mx-auto px-4 relative z-10 text-center">
      <div className="badge-pill mx-auto mb-6 animate-slide-up">
        <span className="w-2 h-2 rounded-full bg-primary animate-pulse-glow" />
        {eyebrow}
      </div>
      <h1 className="text-4xl md:text-6xl font-black tracking-tight mb-5 animate-slide-up" style={{ animationDelay: "0.1s" }}>
        {title} <span className="text-gradient">{highlight}</span>
      </h1>
      <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto animate-slide-up" style={{ animationDelay: "0.2s" }}>
        {description}
      </p>
      {children && (
        <div className="mt-10 animate-slide-up" style={{ animationDelay: "0.3s" }}>
          {children}
        </div>
      )}
    </div>
  </section>
);

export const Section = ({
  id,
  eyebrow,
  title,
  highlight,
  description,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: string;
  title?: ReactNode;
  highlight?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section id={id} className={`py-14 md:py-20 scroll-mt-20 ${className}`}>
    <div className="container mx-auto px-4">
      {(eyebrow || title) && (
        <div className="text-center mb-10 md:mb-14">
          {eyebrow && <span className="text-xs font-bold uppercase tracking-[0.2em] text-primary">{eyebrow}</span>}
          {title && (
            <h2 className="text-3xl md:text-4xl font-bold mt-3">
              {title} {highlight && <span className="text-gradient">{highlight}</span>}
            </h2>
          )}
          {description && <p className="text-muted-foreground mt-4 max-w-2xl mx-auto">{description}</p>}
        </div>
      )}
      {children}
    </div>
  </section>
);

export const IconCard = ({
  icon: Icon,
  title,
  desc,
  badge,
  points,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  badge?: string;
  points?: string[];
}) => (
  <div className="surface-card p-6 flex flex-col group h-full">
    <div className="flex items-start justify-between gap-3 mb-4">
      <div className="w-11 h-11 shrink-0 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
        <Icon size={20} className="text-primary" />
      </div>
      {badge && (
        <span className="text-[11px] font-mono text-primary bg-primary/10 px-2 py-1 rounded-md text-right">{badge}</span>
      )}
    </div>
    <h3 className="text-lg font-bold text-foreground mb-2">{title}</h3>
    <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
    {points && points.length > 0 && (
      <ul className="mt-4 pt-4 border-t border-border space-y-1.5">
        {points.map((p) => (
          <li key={p} className="flex items-start gap-2 text-xs text-muted-foreground">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-primary" />
            {p}
          </li>
        ))}
      </ul>
    )}
  </div>
);

export const StatStrip = ({ stats }: { stats: { value: string; label: string }[] }) => (
  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4 max-w-4xl mx-auto">
    {stats.map((s) => (
      <div key={s.label} className="text-center p-4 md:p-5 rounded-xl border border-border bg-card">
        <div className="text-2xl md:text-3xl font-black text-gradient mb-1">{s.value}</div>
        <div className="text-xs text-muted-foreground">{s.label}</div>
      </div>
    ))}
  </div>
);

export const StepList = ({
  steps,
}: {
  steps: { icon: LucideIcon; title: string; desc: string }[];
}) => (
  <ol className={`grid gap-4 md:gap-6 sm:grid-cols-2 ${steps.length >= 4 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
    {steps.map((s, i) => (
      <li key={s.title} className="surface-card p-6 relative">
        <div className="flex items-center gap-3 mb-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-bold">
            {i + 1}
          </span>
          <s.icon size={18} className="text-primary" />
        </div>
        <h3 className="font-bold text-foreground mb-1.5">{s.title}</h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
      </li>
    ))}
  </ol>
);

export const PrimaryCta = ({ label = `Start with ${SIGNUP_CREDIT} free credit` }: { label?: string }) => (
  <Link to="/register">
    <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 px-8 gap-2 text-base">
      {label} <ArrowRight size={18} />
    </Button>
  </Link>
);

export const CtaBanner = ({
  title = "Put your first agent on the phone today",
  description = `Sign up, verify your email, and ${SIGNUP_CREDIT} of free credit lands in your balance. No card, no subscription, no sales call.`,
}: {
  title?: string;
  description?: string;
}) => (
  <section className="py-16 md:py-24">
    <div className="container mx-auto px-4">
      <div className="glow-border relative overflow-hidden rounded-2xl bg-card px-6 py-12 md:px-12 md:py-16 text-center">
        <div className="absolute inset-0 grid-pattern opacity-20 pointer-events-none" />
        <div className="relative">
          <h2 className="text-3xl md:text-4xl font-bold text-foreground">{title}</h2>
          <p className="text-muted-foreground mt-4 max-w-xl mx-auto">{description}</p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <PrimaryCta />
            <Link to="/pricing">
              <Button size="lg" variant="outline" className="px-8">
                See how pricing works
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  </section>
);
