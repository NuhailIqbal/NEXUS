import { Link } from "react-router-dom";

interface LogoProps {
  size?: "sm" | "lg";
  linked?: boolean;
  className?: string;
}

const Logo = ({ size = "sm", linked = true, className = "" }: LogoProps) => {
  const heightClass = size === "lg" ? "h-11" : "h-9";

  const content = (
    <img
      src="/logo.svg"
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
