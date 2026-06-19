import { Link } from "react-router-dom";

interface LogoProps {
  size?: "sm" | "lg";
  linked?: boolean;
}

const Logo = ({ size = "sm", linked = true }: LogoProps) => {
  const isLg = size === "lg";

  const content = (
    <div className="flex items-center gap-2.5 group">
      {/* Icon mark */}
      <div className={`relative ${isLg ? "w-10 h-10" : "w-8 h-8"}`}>
        {/* Outer glow ring */}
        <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-primary via-accent to-primary opacity-30 blur-sm group-hover:opacity-50 transition-opacity" />
        {/* Main icon container */}
        <div className="relative w-full h-full rounded-xl bg-gradient-to-br from-primary/20 to-accent/10 border border-primary/40 flex items-center justify-center overflow-hidden">
          {/* Inner grid pattern */}
          <div className="absolute inset-0 opacity-20">
            <div className="absolute top-1/2 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gradient-to-b from-transparent via-primary to-transparent" />
          </div>
          {/* Central nexus node */}
          <div className={`relative ${isLg ? "w-3 h-3" : "w-2.5 h-2.5"}`}>
            <div className="absolute inset-0 rounded-full bg-primary animate-pulse" />
            <div className="absolute inset-0 rounded-full bg-gradient-to-br from-primary to-accent" />
            {/* Orbital dots */}
            <div className="absolute -top-1 -right-1 w-1 h-1 rounded-full bg-accent" />
            <div className="absolute -bottom-1 -left-1 w-1 h-1 rounded-full bg-primary" />
          </div>
          {/* Connection lines from center */}
          <div className="absolute top-0 left-1/2 w-px h-1/3 bg-gradient-to-b from-transparent to-primary/40" />
          <div className="absolute bottom-0 left-1/2 w-px h-1/3 bg-gradient-to-t from-transparent to-accent/40" />
          <div className="absolute left-0 top-1/2 h-px w-1/3 bg-gradient-to-r from-transparent to-primary/40" />
          <div className="absolute right-0 top-1/2 h-px w-1/3 bg-gradient-to-l from-transparent to-accent/40" />
        </div>
      </div>

      {/* Wordmark */}
      <div className="flex flex-col items-start leading-none">
        <span
          className={`font-black tracking-[0.15em] bg-gradient-to-r from-foreground via-foreground to-primary/80 bg-clip-text text-transparent ${
            isLg ? "text-2xl" : "text-lg"
          }`}
        >
          EDM
        </span>
        <span
          className={`font-bold tracking-[0.35em] bg-gradient-to-r from-accent to-primary bg-clip-text text-transparent uppercase ${
            isLg ? "text-[0.65rem]" : "text-[0.55rem]"
          }`}
        >
          Nexus
        </span>
      </div>
    </div>
  );

  if (linked) {
    return <Link to="/">{content}</Link>;
  }
  return content;
};

export default Logo;
