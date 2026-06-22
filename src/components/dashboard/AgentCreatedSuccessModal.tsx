import { useEffect } from "react";
import { Link } from "react-router-dom";
import confetti from "canvas-confetti";
import { Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AgentCreatedSuccessModalProps {
  open: boolean;
  agentName: string;
  onClose: () => void;
}

export function AgentCreatedSuccessModal({
  open,
  agentName,
  onClose,
}: AgentCreatedSuccessModalProps) {
  useEffect(() => {
    if (!open) return;

    const duration = 3000;
    const end = Date.now() + duration;
    const colors = ["#3b82f6", "#60a5fa", "#93c5fd", "#2563eb", "#1d4ed8", "#ffffff"];

    confetti({
      particleCount: 120,
      spread: 90,
      startVelocity: 45,
      origin: { y: 0.6 },
      colors,
    });

    const interval = window.setInterval(() => {
      if (Date.now() > end) {
        window.clearInterval(interval);
        return;
      }
      confetti({
        particleCount: 40,
        angle: 60,
        spread: 60,
        origin: { x: 0, y: 0.7 },
        colors,
      });
      confetti({
        particleCount: 40,
        angle: 120,
        spread: 60,
        origin: { x: 1, y: 0.7 },
        colors,
      });
    }, 250);

    return () => window.clearInterval(interval);
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-success-title"
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-in fade-in-0 duration-300"
    >
      <div className="absolute inset-0 bg-background/80 backdrop-blur-md" />

      <div className="relative w-full max-w-lg rounded-2xl border border-primary/20 bg-card p-8 shadow-2xl animate-in zoom-in-95 fade-in-0 duration-500">
        <div className="pointer-events-none absolute -inset-px rounded-2xl bg-gradient-to-br from-primary/20 via-transparent to-primary/10 opacity-60 blur-xl" />

        <div className="relative flex flex-col items-center text-center">
          <div className="relative">
            <span className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary/30" />
            <div
              className="flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/70 shadow-[0_0_40px_hsl(var(--primary)/0.6)] animate-in zoom-in-50 duration-700"
              style={{ animationTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)" }}
            >
              <Check
                className="h-12 w-12 text-primary-foreground animate-in zoom-in-0 duration-500"
                strokeWidth={3}
                style={{ animationDelay: "200ms", animationFillMode: "both" }}
              />
            </div>
          </div>

          <h2
            id="agent-success-title"
            className="mt-6 text-2xl font-bold tracking-tight sm:text-3xl"
          >
            🎉 Your AI Agent Has Been Created!
          </h2>

          {agentName && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-sm font-medium text-primary">
              <Sparkles className="h-3.5 w-3.5" />
              {agentName}
            </p>
          )}

          <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground sm:text-base">
            Your agent is live and ready to take calls. Use{" "}
            <span className="font-semibold text-foreground">Talk to Agent</span>{" "}
            on the My Agents page to try it out.
          </p>

          <div className="mt-8 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
            <Button asChild size="lg" className="bg-primary text-primary-foreground">
              <Link to="/dashboard/ai-agents" onClick={onClose}>
                Go to My Agents
              </Link>
            </Button>
            <Button variant="outline" size="lg" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
