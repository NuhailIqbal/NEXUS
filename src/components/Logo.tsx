import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "next-themes";

interface LogoProps {
  size?: "sm" | "lg";
  linked?: boolean;
  className?: string;
}

const Logo = ({ size = "sm", linked = true, className = "" }: LogoProps) => {
  const heightClass = size === "lg" ? "h-11" : "h-9";
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Avoid a hydration/first-paint mismatch — default to the dark asset until mounted.
  useEffect(() => setMounted(true), []);
  const src = mounted && resolvedTheme === "light" ? "/logo-light.svg" : "/logo.svg";

  const content = (
    <img
      src={src}
      alt="EDM Nexus"
      className={`${heightClass} w-auto object-contain ${className}`}
    />
  );

  if (linked) {
    return (
      <Link to="/" className="inline-flex items-center">
        {content}
      </Link>
    );
  }
  return content;
};

export default Logo;
